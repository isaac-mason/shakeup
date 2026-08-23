import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';
import { exportShape, runModule } from './exec-helpers.ts';

const build = async (files: Record<string, string>) =>
    (await bundle({ input: '/main.js', fs: createMemoryFs(files), external: [], output: { minify: { compress: false } } })).code;

/** The inlined build must compute what the same graph computes with the directive stripped. */
const parity = async (files: Record<string, string>) => {
    const on = await build(files);
    const stripped = Object.fromEntries(
        Object.entries(files).map(([k, v]) => [k, v.replace(/\/\* @inline \*\//g, '')]),
    );
    expect(exportShape(await runModule(on))).toEqual(exportShape(await runModule(await build(stripped))));
    return on;
};

describe('cross-module @inline', () => {
    it('inlines an annotated helper imported from another module', async () => {
        const code = await parity({
            '/lib.js': '/* @inline */ export function add(a, b) { return a + b; }',
            '/main.js': 'import { add } from "./lib.js";\nexport const out = add(40, 2);',
        });
        expect((await runModule(code)).out).toBe(42);
        expect(code).not.toMatch(/\badd\s*\(/); // the call is gone
        expect(code).not.toContain('function add'); // and the donor shook out
    });

    it('inlines a `const` arrow donor', async () => {
        const code = await parity({
            '/lib.js': '/* @inline */ export const twice = (a) => a * 2;',
            '/main.js': 'import { twice } from "./lib.js";\nexport const out = twice(21);',
        });
        expect((await runModule(code)).out).toBe(42);
        expect(code).not.toMatch(/\btwice\s*\(/);
    });

    it('allows a donor that only references GLOBALS', async () => {
        const code = await parity({
            '/lib.js': '/* @inline */ export function mag(a) { return Math.abs(a); }',
            '/main.js': 'import { mag } from "./lib.js";\nexport const out = mag(-5);',
        });
        expect((await runModule(code)).out).toBe(5);
        expect(code).not.toMatch(/\bmag\s*\(/);
    });

    it('REFUSES a donor whose body references a module-scope binding of its own', async () => {
        // `SCALE` lives in the donor's module scope and would dangle if the body moved.
        const code = await parity({
            '/lib.js': 'const SCALE = 3;\n/* @inline */ export function grow(a) { return a * SCALE; }',
            '/main.js': 'import { grow } from "./lib.js";\nexport const out = grow(2);',
        });
        expect((await runModule(code)).out).toBe(6);
        expect(code).toMatch(/\bgrow\s*\(/); // refused
    });

    it('REFUSES when a global the donor uses is shadowed at the call site', async () => {
        const code = await parity({
            '/lib.js': '/* @inline */ export function mag(a) { return Math.abs(a); }',
            '/main.js': [
                'import { mag } from "./lib.js";',
                'export function f() { const Math = { abs: () => 99 }; return mag(-5); }',
                'export const out = f();',
            ].join('\n'),
        });
        // `mag` is DEFINED in the donor, where `Math` is the global — so the un-inlined call yields 5.
        // Inlining it into a scope with a local `Math` would yield 99: that is exactly the miscompile
        // the hygiene check exists to prevent, so the call must survive.
        expect((await runModule(code)).out).toBe(5);
        expect(code).toMatch(/\bmag\s*\(/); // refused
    });

    it('leaves an un-annotated import alone', async () => {
        const code = await parity({
            '/lib.js': 'export function plain(a) { return a + 1; }',
            '/main.js': 'import { plain } from "./lib.js";\nexport const out = plain(1);',
        });
        expect((await runModule(code)).out).toBe(2);
        expect(code).toMatch(/\bplain\s*\(/);
    });
});
