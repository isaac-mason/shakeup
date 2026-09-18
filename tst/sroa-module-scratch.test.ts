import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// The house style for a hot numeric path is a module-level scratch buffer reused as per-call
// temporary storage:
//
//   const _m = /* @__PURE__ */ [0, 0, 0];
//   /* @optimize */ function f(out, a) { _m[0] = a[0] * 2; out[0] = _m[0]; }
//
// It allocates nothing, which is why it is written that way — but it also never becomes scalars, so
// every access stays a heap load plus a bounds check. compilecat localizes such a buffer when it can
// prove single ownership; shakeup's SROA only handles a function-LOCAL array literal, so the idiom
// (1067 buffers in crashcat) is left on the floor.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.js', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};
const run = (code: string, call: string) => {
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
};

const ONE_OWNER = `const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function f(out, a) {
    _m[0] = a[0] * 2;
    _m[1] = a[1] * 2;
    _m[2] = a[2] * 2;
    out[0] = _m[0] + _m[1] + _m[2];
    return out;
}`;

describe('module scratch localization', () => {
    it('scalarizes a single-owner module buffer', async () => {
        const code = await build({ '/m.js': ONE_OWNER });
        // the buffer is gone entirely, and nothing indexes it any more
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('preserves behaviour', async () => {
        const on = await build({ '/m.js': ONE_OWNER }, { optimize: true });
        const off = await build({ '/m.js': ONE_OWNER }, { optimize: false });
        const call = 'f([0], [1, 2, 3])';
        expect(run(on, call)).toEqual(run(off, call));
    });

    // Two owners cannot be LOCALIZED — each would get its own copy and the hand-off between them would
    // break — and scalarizing IN PLACE is not the fallback it looks like. Module-scope `let` scalars
    // are context slots: `bench/.ab/micro` measures them 8.7x slower than the array indexing they
    // replace, so rewriting here would be a pessimization dressed up as an optimization. The array
    // stays, and the behaviour is unchanged either way.
    it('leaves a buffer shared by two functions alone, preserving behaviour', async () => {
        const src = `const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function f(out, a) { _m[0] = a[0]; out[0] = _m[0]; return out; }

/* @optimize */
export function g(out, a) { _m[0] = a[0] * 3; out[0] = _m[0]; return out; }`;
        const on = await build({ '/m.js': src }, { optimize: true });
        const off = await build({ '/m.js': src }, { optimize: false });
        const call = '[f([0], [7]), g([0], [7])]';
        expect(run(on, call)).toEqual(run(off, call));
        expect(on).toMatch(/_m\s*\[/);
    });

    it('scalarizes even when an unannotated function also reads it', async () => {
        const src = `const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function f(out, a) { _m[0] = a[0]; out[0] = _m[0]; return out; }

export function peek() { return _m[0]; }`;
        const on = await build({ '/m.js': src }, { optimize: true });
        const off = await build({ '/m.js': src }, { optimize: false });
        const call = '[f([0], [5]), peek()]';
        expect(run(on, call)).toEqual(run(off, call));
    });

    // THE safety property: a buffer used as a whole object cannot become scalars, because the
    // consumer holds a reference the scalars cannot stand in for.
    it('refuses a buffer that escapes as a whole object', async () => {
        const code = await build({
            '/m.js': `const _m = /* @__PURE__ */ [0, 0, 0];
export function sink(v) { return v; }
/* @optimize */
export function f(a) { _m[0] = a; return sink(_m); }`,
        });
        expect(code).toMatch(/_m\b/);
    });

    it('refuses a dynamically indexed buffer', async () => {
        const code = await build({
            '/m.js': `const _m = /* @__PURE__ */ [0, 0, 0];
/* @optimize */
export function f(i, a) { _m[i] = a; return _m[0]; }`,
        });
        expect(code).toMatch(/_m\s*\[/);
    });

    // The inliner substitutes a `const` argument at its use sites rather than binding it, so the
    // helper's body reads `_m[0]` directly and SROA still sees a buffer it can take apart. Binding it
    // (`const out = _m;`) would alias the buffer and refuse the whole rewrite.
    it('scalarizes when the buffer is filled by an inlined helper', async () => {
        const src = `const _m = /* @__PURE__ */ [0, 0, 0];

function fill(out, a) { out[0] = a[0] * 2; }

/* @optimize */
export function f(out, a) {
    fill(_m, a);
    out[0] = _m[0];
    return out;
}`;
        const code = await build({ '/m.js': src });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    // Same shape, ACROSS MODULES — which is where crashcat actually lives: the scratch buffer sits in
    // the consumer and the helper that fills it (`vec3.subtract`, `getTotalLambda`) comes from another
    // module. Cross-module inlining runs in `bundle()`, AFTER the per-module optimize tier, so the
    // call that hides the buffer is still standing when SROA looks at it. The tier has to run again on
    // whatever the cross-module splice touched.
    it('scalarizes when the buffer is filled by a helper from another module', async () => {
        const code = await build({
            '/m.js': `import { fill } from './h.js';

const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function f(out, a) {
    fill(_m, a);
    out[0] = _m[0] + _m[1];
    return out;
}`,
            '/h.js': `export function fill(out, a) { out[0] = a[0] * 2; out[1] = a[1] * 2; }`,
        });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('keeps the cross-module result correct', async () => {
        const files = {
            '/m.js': `import { fill } from './h.js';
const _m = /* @__PURE__ */ [0, 0, 0];
/* @optimize */
export function f(out, a) { fill(_m, a); out[0] = _m[0] + _m[1]; return out; }`,
            '/h.js': `export function fill(out, a) { out[0] = a[0] * 2; out[1] = a[1] * 2; }`,
        };
        const strip = (c: string) => c.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        const on = new Function(`${strip(await build(files))}\nreturn f([0], [3, 4]);`)();
        const off = new Function(`${strip(await build(files, { optimize: false }))}\nreturn f([0], [3, 4]);`)();
        expect(on).toEqual(off);
    });

    // The house style does not write the buffer as a literal — it writes `vec3.create()`, and the
    // factory lives in another package, so there is no literal to read the shape from and no in-file
    // type to resolve `Vec3` against.
    //
    // The shape is NOT inferred from the uses. Inferring it would approve `const out = res` — a plain
    // ALIAS — and scalarizing that stops the writes through it from ever reaching `res`. What makes a
    // rewrite sound is that the value is FRESH, and only a literal proves that. So the fix is to reach
    // the literal: `@flatten` means "inline what this function calls", the buffer is the function's
    // own data, and inlining its factory turns the initialiser into the literal `[0, 0, 0]` that
    // literal-mode SROA already handles.
    it('scalarizes a buffer built by an opaque factory call', async () => {
        const code = await build({
            '/m.js': `import { create } from './h.js';

const _m = /* @__PURE__ */ create();

/* @optimize */
export function f(a) {
    _m[0] = a * 2;
    _m[1] = a;
    _m[2] = _m[0] + _m[1];
    return _m[2];
}`,
            '/h.js': `export function create() { return [0, 0, 0]; }`,
        });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    // A module-scope buffer OUTLIVES the call, and a read before the first write of a step sees what
    // the last call left there. Replacing it with uninitialised scalars would hand back `undefined`
    // the first time and silently change the second — so the factory's value has to be carried onto
    // the scalars, not dropped.
    it('carries the opaque initial value onto the scalars', async () => {
        const files = {
            '/m.js': `import { create } from './h.js';
const _acc = /* @__PURE__ */ create();
/* @optimize */
export function add(x) { _acc[0] = _acc[0] + x; _acc[1] = _acc[1] + 1; return [_acc[0], _acc[1]]; }`,
            '/h.js': `export function create() { return [7, 0]; }`,
        };
        const strip = (c: string) => c.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
        const call = 'add(1), add(2)';
        const on = new Function(`${strip(await build(files))}\nreturn (${call});`)();
        expect(on).toEqual([10, 2]);
        expect(on).toEqual(new Function(`${strip(await build(files, { optimize: false }))}\nreturn (${call});`)());
    });

    it('refuses an opaque buffer that is also used as a whole object', async () => {
        const code = await build({
            '/m.js': `import { create, sum } from './h.js';
const _m = /* @__PURE__ */ create();
/* @optimize */
export function f(a) { _m[0] = a; return sum(_m); }`,
            '/h.js': `export function create() { return [0, 0]; }
export function sum(v) { return v.reduce((a, b) => a + b, 0); }`,
        });
        expect(code).toMatch(/_m\b/);
    });

    // The reach is limited to what `@flatten` covers. A buffer no optimized function touches keeps its
    // factory call: nothing asked for that initialiser to be inlined.
    it('leaves the factory alone for a buffer no optimized function uses', async () => {
        const code = await build({
            '/m.js': `import { create } from './h.js';
const _cold = /* @__PURE__ */ create();
export function g() { return _cold[0]; }
/* @optimize */
export function f(a) { return a + 1; }`,
            '/h.js': `export function create() { return [0, 0, 0]; }`,
        });
        expect(code).toMatch(/_cold\s*=\s*\/\* @__PURE__ \*\/\s*\w+\(\)/);
    });
});
