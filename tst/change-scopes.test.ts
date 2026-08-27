import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { setChangeScopeMode } from '../src/passes/compress/index.ts';

// CHANGE SCOPES — `llm/notes/compressor-perf-plan.md`. The compress fixed point stamps, per round,
// which functions changed at or below them, so a later round can skip the ones that did not. Rounds
// 2-6 on the crashcat chunk mutate 320 / 63 / 10 / 1 / 0 functions out of ~1,205 and still re-walk
// everything at ~41ms a round.
//
// This phase only WRITES the stamps. The guarantee that matters now is that writing them changes
// NOTHING about the output — which is also the guarantee that makes the skipping phase checkable,
// because any later divergence is then attributable to the skip and not to the bookkeeping.
const FILES: Record<string, string> = {
    '/main.js': `
        import { compute, Holder } from './lib.js';
        const h = new Holder(2);
        export const out = [compute(1, 2), h.doubled(), h.nested()];
    `,
    '/lib.js': `
        export function compute(a, b) {
            // nested functions, blocks and closures: the shapes the stamp's ancestor walk has to
            // traverse. A mutation inside the inner block must mark every enclosing function.
            const scale = (x) => {
                if (x > 0) {
                    const bump = () => x * 2;
                    return bump();
                }
                return 0;
            };
            let t = 0;
            for (let i = 0; i < 2; i++) t += scale(a) + scale(b);
            return t;
        }
        export class Holder {
            #v;
            constructor(v) { this.#v = v; }
            doubled() { return this.#v * 2; }
            nested() {
                const inner = function () {
                    const deeper = () => this;
                    return typeof deeper;
                };
                return inner.call(null);
            }
        }
    `,
};

const build = async (minify: boolean) => {
    const r = await bundle({ entry: '/main.js', fs: createMemoryFs(FILES), output: { minify } });
    expect(r.errors).toEqual([]);
    return r.code;
};

describe('change-scope stamping does not affect output', () => {
    it('emits byte-identical code with stamping off, on and verified', async () => {
        try {
            setChangeScopeMode('off');
            const off = await build(true);
            setChangeScopeMode('on');
            const on = await build(true);
            setChangeScopeMode('verify');
            const verified = await build(true);
            expect(on).toBe(off);
            expect(verified).toBe(off);
            // Guard against all three being trivially empty or unminified.
            expect(off.length).toBeGreaterThan(50);
        } finally {
            setChangeScopeMode('on');
        }
    });

    it('the ancestor invariant holds on a deeply nested program', async () => {
        // `verify` throws if a stamped function has an unstamped enclosing function — the exact bug
        // that would let the skip walk past a subtree containing a dirty nested function.
        try {
            setChangeScopeMode('verify');
            const code = await build(true);
            expect(code).toContain('out');
        } finally {
            setChangeScopeMode('on');
        }
    });

    it('still evaluates correctly under every mode', async () => {
        for (const mode of ['off', 'on', 'verify'] as const) {
            try {
                setChangeScopeMode(mode);
                const code = await build(true);
                const mod = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as { out: unknown };
                expect(mod.out).toEqual([12, 4, 'function']);
            } finally {
                setChangeScopeMode('on');
            }
        }
    });
});
