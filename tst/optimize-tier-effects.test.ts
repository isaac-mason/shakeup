import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { bundle, createMemoryFs } from '../src/index.ts';
import { parseProgram } from '../src/parser/index.ts';
import { inlineFunctions } from '../src/passes/optimize/inline-functions.ts';

// The optimize tier's existing coverage asserts only weak properties:
//   - tst/compilecat-equivalence.test.ts asserts BEHAVIOUR IS UNCHANGED, and says so explicitly:
//     "A case shakeup does not optimize still passes".
//   - tst/output-optimize.test.ts asserts optimize:true output DIFFERS from optimize:false.
// Neither can fail when the tier silently does nothing. These pin the effects themselves.

const inlines = (src: string): boolean => {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    const semantic = createSemantic();
    analyze(semantic, program);
    return inlineFunctions(program, semantic, src);
};

describe('donor shapes accepted by @inline', () => {
    it('inlines a single-return-expression donor', () => {
        expect(
            inlines(`
/* @inline */
function madd(a, b, c) { return a * b + c; }
export function caller(x) { return madd(x, 2, 3); }`),
        ).toBe(true);
    });

    // The out-param idiom is how every vec3/quat/mat4 helper in the math package is written, so it is
    // the shape that decides whether the tier does anything at all on a real numeric codebase.
    it('inlines a void donor that writes through an out-param', () => {
        expect(
            inlines(`
/* @inline */
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
export function caller(out, a, b) { addTo(out, a, b); }`),
        ).toBe(true);
    });

    it('inlines a multi-statement void donor', () => {
        expect(
            inlines(`
/* @inline */
function addTo(out, a, b) { out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; }
export function caller(out, a, b) { addTo(out, a, b); }`),
        ).toBe(true);
    });

    it('inlines a donor that writes an out-param then returns it', () => {
        expect(
            inlines(`
/* @inline */
function addTo(out, a, b) { out[0] = a[0] + b[0]; return out; }
export function caller(out, a, b) { return addTo(out, a, b); }`),
        ).toBe(true);
    });
});

describe('@optimize / @flatten are caller-side', () => {
    // compilecat: "@flatten — a caller-side bulk directive. Every resolvable call inside the annotated
    // function's body is treated as if its call site had /* @inline */", and @optimize implies @flatten.
    // OPTIMIZE_IMPLIES is FLATTEN|SROA, but inline-functions.ts only ever queries DIRECTIVE.INLINE, so
    // nothing consumes FLATTEN as "inline the calls in this body".
    it('@flatten on the caller inlines calls in its body', () => {
        expect(
            inlines(`
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
/* @flatten */
export function caller(out, a, b) { addTo(out, a, b); }`),
        ).toBe(true);
    });

    it('@optimize on the caller inlines calls in its body', () => {
        expect(
            inlines(`
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
/* @optimize */
export function caller(out, a, b) { addTo(out, a, b); }`),
        ).toBe(true);
    });
});

describe('the effects survive a real bundle', () => {
    const build = async (src: string, output: Record<string, unknown>) => {
        const r = await bundle({ input: '/m.js', fs: createMemoryFs({ '/m.js': src }), output } as never);
        expect(r.errors).toEqual([]);
        return r.chunks[0].code;
    };

    const SRC = `
/* @inline */
function addTo(out, a, b) { out[0] = a[0] + b[0]; }
export function caller(out, a, b) { addTo(out, a, b); }`;

    it('the call is gone from the chunk', async () => {
        expect(await build(SRC, { optimize: true })).not.toMatch(/addTo\s*\(/);
    });

    it('optimize:false leaves the call in place', async () => {
        expect(await build(SRC, { optimize: false })).toMatch(/addTo\s*\(/);
    });
});

// `optimize: false` has to turn the tier OFF — all of it. The per-module half reads the option in
// `scan`, but the CROSS-MODULE half runs from `bundle()` and read nothing, so an imported helper was
// still inlined and its caller's buffers still scalarized in a build that asked for none of it. It
// surfaced as a bogus benchmark arm: a "no optimize" bundle that was still optimized, which made the
// optimize tier look free when it had simply never been switched off.
describe('the optimize option gates the cross-module half too', () => {
    const FILES = {
        '/m.js': `import { fill } from './h.js';
const _m = /* @__PURE__ */ [0, 0, 0];
/* @optimize */
export function f(a) { fill(_m, a); return _m[0] + _m[1]; }`,
        '/h.js': `export function fill(out, a) { out[0] = a * 2; out[1] = a; }`,
    };

    it('leaves the imported call standing and the buffer whole', async () => {
        const r = await bundle({
            input: '/m.js',
            fs: createMemoryFs(FILES),
            external: [],
            output: { optimize: false },
        } as never);
        expect(r.errors).toEqual([]);
        const code = r.chunks[0].code;
        expect(code).toMatch(/fill\w*\s*\(/);
        expect(code).toMatch(/_m\s*\[/);
        expect(code).not.toMatch(/_m_0\b/);
    });

    it('still inlines and scalarizes when the option is on', async () => {
        const r = await bundle({
            input: '/m.js',
            fs: createMemoryFs(FILES),
            external: [],
            output: { optimize: true },
        } as never);
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].code).not.toMatch(/_m\s*\[/);
    });
});
