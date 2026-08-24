import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { runModule } from './exec-helpers.ts';

// Regression tests for which DECLARATION forms kill a binding in liveness.
//
// Found during the CFG migration's Phase 0b: `liveness.ts` treated a declarator as a kill even with NO
// initialiser. `var` is hoisted, so a store can textually PRECEDE its declaration and still be live
// through it — and treating the bare declaration as a kill made that store look dead, so dead-store
// DELETED it. That was a real miscompile in shipped code, caught by diffing the structural analysis
// against the Closure-aligned CFG port, which only kills an INITIALISED declarator
// (`computeGenKill`'s `c.hasChildren()` test).
const build = async (src: string) => {
    const files: Record<string, string> = { '/e.js': src };
    const r = await bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        output: { minify: { compress: true } },
    });
    return r.code;
};

describe('a bare declaration does not kill', () => {
    it('keeps a store that precedes a hoisted `var` declaration', async () => {
        const code = await build('/* @optimize */\nfunction f(){ h = 7; var h; return h; }\nexport const out = f();\n');
        expect((await runModule(code)).out).toBe(7); // never undefined
    });

    it('keeps a store read after a bare `var` in a loop', async () => {
        const src =
            '/* @optimize */\nfunction f(n){ let t = 0; for (let i = 0; i < n; i++) { t += acc; var acc; acc = i; } return t; }\n' +
            'export const out = f(3);\n';
        // iteration 0 reads `acc` before it is ever assigned (undefined → NaN), then 1, 2 accumulate.
        expect((await runModule(await build(src))).out).toBeNaN();
    });

    it('still kills an INITIALISED declaration (the store before it really is dead)', async () => {
        const code = await build('/* @optimize */\nfunction f(){ let h; h = 7; let g = 1; h = g; return h; }\nexport const out = f();\n');
        expect((await runModule(code)).out).toBe(1);
        expect(code).not.toMatch(/=\s*7/); // the dead `h = 7` is gone
    });

    it('a bare `let` does not resurrect a genuinely dead store', async () => {
        const code = await build('/* @optimize */\nfunction f(){ let h = 1; h = 2; let q; q = 3; return h + q; }\nexport const out = f();\n');
        expect((await runModule(code)).out).toBe(5);
    });
});
