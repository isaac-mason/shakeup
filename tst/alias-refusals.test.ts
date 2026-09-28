import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { runModule } from './exec-helpers.ts';

// Alias-shaped inputs (`const b = a`) through the full minifier. Each case is a miscompile that substituting the
// alias would cause, checked by EXECUTION, not just by shape, because the risk is silently changing a value.

const build = async (src: string, extra: Record<string, string> = {}) => {
    const files: Record<string, string> = { '/e.js': src, ...extra };
    const r = await bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        output: { minify: { compress: true } },
    });
    return r.chunks[0].code;
};

describe('alias refusals (each guards a miscompile)', () => {
    it('REFUSES a hoisted `var` target: reads before its init see undefined, not the value', async () => {
        // The guard compilecat's write-tally CANNOT express — `var a = 1` reports zero writes here.
        const src = 'function f() {\n  const b = a;\n  var a = 1;\n  return b;\n}\nexport const out = f();\n';
        const code = await build(src);
        expect(code).toMatch(/\bb = a\b/); // still bound to `a`, not substituted
        expect((await runModule(code)).out).toBe(undefined); // and still correct
    });

    it('REFUSES a reassigned target', async () => {
        const src =
            'function f(p) {\n  let a = p;\n  const b = a;\n  a = 99;\n  return b;\n}\nexport const out = f(1);\n';
        const code = await build(src);
        expect((await runModule(code)).out).toBe(1); // NOT 99
    });

    it('REFUSES when the alias itself is reassigned', async () => {
        const src =
            'function f(a) {\n  let b = a;\n  b = 99;\n  return b;\n}\nexport const out = f(1);\n';
        const code = await build(src);
        expect((await runModule(code)).out).toBe(99);
    });

    it('REFUSES a live ESM import binding (`export let` can be reassigned by the exporter)', async () => {
        const code = await build('import { counter, bump } from "./m.js";\nconst b = counter;\nbump();\nexport const out = [b, counter];\n', {
            '/m.js': 'export let counter = 1;\nexport function bump() { counter = 99; }\n',
        });
        const { out } = (await runModule(code)) as { out: number[] };
        expect(out).toEqual([1, 99]); // b captured 1; a fresh read sees 99
    });

    it('REFUSES an exported alias — substituting the specifier would rename the public export', async () => {
        const code = await build('import { a } from "./m.js";\nconst b = a;\nexport { b };\n', {
            '/m.js': 'export const a = 5;\n',
        });
        expect((await runModule(code)).b).toBe(5);
    });

    it('does not substitute a read where the target NAME is shadowed', async () => {
        const src =
            'function f(a) {\n  const b = a;\n  let out = b;\n  { let a = 99; out += b; }\n  return out;\n}\n' +
            'export const out = f(1);\n';
        const code = await build(src);
        expect((await runModule(code)).out).toBe(2); // 1 + 1, never 1 + 99
    });

    it('REFUSES a destructured declarator (its init is the whole RHS, not the element)', async () => {
        const src = 'function f(arr) {\n  const [b] = arr;\n  return b + b;\n}\nexport const out = f([4]);\n';
        const code = await build(src);
        expect((await runModule(code)).out).toBe(8); // never `arr + arr`
    });

    it('REFUSES aliasing an unresolved global', async () => {
        const src = 'function f() {\n  const b = someGlobal;\n  return b + b;\n}\nglobalThis.sink = f;\n';
        const code = await build(src);
        expect(code).toMatch(/\bb = someGlobal\b/);
    });
});
