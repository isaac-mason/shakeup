import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// WHERE the scalars land decides whether SROA is a win or a loss.
//
// A module-scope `let` is a context slot, not a register. Replacing `_m[0]` with a module-scope
// `_m_0` measured 8.7x SLOWER than the array indexing it replaced (`bench/.ab/micro`), while the same
// scalars as function LOCALS measured 1.3x faster. So scalarizing a module-scope buffer in place is a
// pessimization, and the rewrite is only worth doing if the scalars can be LOCALIZED into the one
// function that uses the buffer.
//
// That is sound only when the buffer carries nothing between calls — every field READ must be
// preceded by an unconditional WRITE at the top level of that function's body. A scratch buffer
// filled before use qualifies; an accumulator read before it is written does not, and keeps its array.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.js', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};
const run = (code: string, call: string) => {
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
};
const bodyOf = (code: string, name: string): string => {
    const at = code.indexOf(`function ${name}(`);
    if (at === -1) throw new Error(`no function ${name} in chunk`);
    let depth = 0;
    let i = code.indexOf('{', at);
    const start = i;
    for (;; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) break;
    }
    return code.slice(start, i + 1);
};

describe('module scratch is localized, not scalarized in place', () => {
    it('moves the scalars into the one function that uses them', async () => {
        const code = await build({
            '/m.js': `const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function f(a, b) {
    _m[0] = a + b;
    _m[1] = a - b;
    _m[2] = a * b;
    return _m[0] + _m[1] + _m[2];
}`,
        });
        // no MODULE-SCOPE binding for the buffer, in either form — anchored at column 0, since a
        // localized declaration is indented inside the function and would match a looser pattern
        expect(code).not.toMatch(/^(const|let|var)\s+_m\b/m);
        expect(code).not.toMatch(/^(const|let|var)\s+_m_0\b/m);
        // and nothing indexes the buffer any more
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('preserves the result', async () => {
        const files = {
            '/m.js': `const _m = /* @__PURE__ */ [0, 0, 0];
/* @optimize */
export function f(a, b) { _m[0] = a + b; _m[1] = a - b; _m[2] = a * b; return _m[0] + _m[1] + _m[2]; }`,
        };
        expect(run(await build(files), 'f(7, 3)')).toEqual(run(await build(files, { optimize: false }), 'f(7, 3)'));
    });

    // Two owners: localizing would give each its own copy and break the hand-off between them. The
    // array stays, because module-scope scalars would be slower than leaving it alone.
    it('leaves a buffer shared by two functions as an array', async () => {
        const code = await build({
            '/m.js': `const _m = /* @__PURE__ */ [0, 0, 0];

/* @optimize */
export function put(a) { _m[0] = a; _m[1] = a * 2; _m[2] = a * 3; }

/* @optimize */
export function get() { return _m[0] + _m[1] + _m[2]; }`,
        });
        expect(code).toMatch(/_m\s*\[/);
        expect(code).not.toMatch(/\b_m_0\b/);
    });

    // An accumulator: `_m[0]` is READ before anything writes it, so its value crosses calls. Localizing
    // would restart it every call.
    it('leaves a buffer read before it is written as an array', async () => {
        const files = {
            '/m.js': `const _acc = /* @__PURE__ */ [0, 0];
/* @optimize */
export function add(x) { _acc[0] = _acc[0] + x; _acc[1] = _acc[1] + 1; return [_acc[0], _acc[1]]; }`,
        };
        const code = await build(files);
        expect(code).toMatch(/_acc\s*\[/);
        const call = 'add(1), add(2)';
        expect(run(code, call)).toEqual([3, 2]);
        expect(run(code, call)).toEqual(run(await build(files, { optimize: false }), call));
    });

    // A write that only happens on one branch does not count: the other path reaches the read with
    // whatever the last call left behind.
    it('leaves a conditionally written buffer as an array', async () => {
        const files = {
            '/m.js': `const _m = /* @__PURE__ */ [0, 0];
/* @optimize */
export function f(a, flag) { if (flag) { _m[0] = a; _m[1] = a * 2; } return _m[0] + _m[1]; }`,
        };
        const code = await build(files);
        expect(code).toMatch(/_m\s*\[/);
        const call = 'f(5, true), f(9, false)';
        expect(run(code, call)).toEqual(run(await build(files, { optimize: false }), call));
    });

    // The straight-line case above folds away completely once the scalars are function locals, which
    // hides WHERE they landed. A loop keeps them: the buffer is rewritten across iterations, so the
    // declaration has to be visible, and it has to be inside the function rather than at module scope.
    it('declares the scalars inside the owning function', async () => {
        const code = await build({
            '/m.js': `const _m = /* @__PURE__ */ [0, 0];

/* @optimize */
export function f(xs) {
    let total = 0;
    for (let i = 0; i < xs.length; i++) {
        _m[0] = xs[i] * 2;
        _m[1] = xs[i] + 1;
        total += _m[0] * _m[1];
    }
    return total;
}`,
        });
        expect(code).not.toMatch(/^(const|let|var)\s+_m/m);
        expect(bodyOf(code, 'f')).toMatch(/\b(let|const|var)\s+_m_0\b/);
        expect(run(code, 'f([1, 2, 3])')).toBe(2 * 2 + 4 * 3 + 6 * 4);
    });
});
