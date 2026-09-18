import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// A BLOCK splice binds every parameter to its argument up front:
//   { const out = _m; const a = v; out[0] = a[0]; }
// That prologue ALIASES the argument, and an alias is fatal downstream: SROA refuses a buffer used
// as a whole object, so a module scratch passed to an inlined helper never becomes scalars — the
// exact shape a numeric library is built from. compilecat substitutes a simple argument at its use
// sites instead (`FunctionArgumentInjector`), leaving `_m[0]` directly in the body.

const build = async (files: Record<string, string>, output: Record<string, unknown> = { optimize: true }) => {
    const r = await bundle({ input: '/m.js', fs: createMemoryFs(files), external: [], output } as never);
    expect(r.errors).toEqual([]);
    return r.chunks[0].code;
};
const run = (code: string, call: string) => {
    const js = code.replace(/^\s*export\s*\{[^}]*\}\s*;?/gm, '').replace(/\bexport\s+/g, '');
    return new Function(`${js}\nreturn (${call});`)();
};

describe('simple arguments are substituted, not bound', () => {
    const SRC = `const _m = /* @__PURE__ */ [0, 0, 0];

function fill(out, a) { out[0] = a[0] * 2; out[1] = a[1] * 2; }

/* @optimize */
export function f(res, v) {
    fill(_m, v);
    res[0] = _m[0] + _m[1];
    return res;
}`;

    it('does not alias the argument into a prologue binding', async () => {
        const code = await build({ '/m.js': SRC });
        expect(code).not.toMatch(/const\s+\w+\s*=\s*_m\s*;/);
    });

    it('lets SROA scalarize a buffer passed to an inlined helper', async () => {
        const code = await build({ '/m.js': SRC });
        expect(code).not.toMatch(/_m\s*\[/);
    });

    it('preserves behaviour', async () => {
        const on = await build({ '/m.js': SRC }, { optimize: true });
        const off = await build({ '/m.js': SRC }, { optimize: false });
        const call = 'f([0], [3, 4])';
        expect(run(on, call)).toEqual(run(off, call));
    });

    // An argument that is NOT simple must still be bound once: substituting it would re-evaluate it
    // at every use, duplicating work and any side effect.
    it('still binds an argument with a side effect', async () => {
        const src = `let calls = 0;
function bump() { calls++; return [1, 2]; }
function fill(out, a) { out[0] = a[0]; out[1] = a[0]; }
/* @optimize */
export function f(res) { fill(res, bump()); return [res[0], calls]; }`;
        const on = await build({ '/m.js': src }, { optimize: true });
        const off = await build({ '/m.js': src }, { optimize: false });
        expect(run(on, 'f([0, 0])')).toEqual(run(off, 'f([0, 0])'));
    });

    it('still binds a parameter the body reassigns', async () => {
        const src = `function walk(n, limit) { while (n < limit) n = n + 1; return n; }
/* @optimize */
export function f(start, limit) { return walk(start, limit); }`;
        const on = await build({ '/m.js': src }, { optimize: true });
        const off = await build({ '/m.js': src }, { optimize: false });
        expect(run(on, 'f(2, 6)')).toEqual(run(off, 'f(2, 6)'));
    });
});
