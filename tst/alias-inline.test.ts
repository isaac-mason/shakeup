import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { runModule } from './exec-helpers.ts';

// Alias inline — path 3 of compilecat `inline_variables`. See src/passes/compress/alias-inline.ts.
// Each REFUSAL case below is a miscompile the corresponding guard prevents; several are checked by
// EXECUTION, not just by shape, because the whole risk of this pass is silently changing a value.

const build = async (src: string, extra: Record<string, string> = {}) => {
    const files: Record<string, string> = { '/e.js': src, ...extra };
    const r = await bundle({
        entry: '/e.js',
        fs: { read: (i) => files[i] ?? null, exists: (i) => i in files },
        external: [],
        // `compress: true` = CompressMode 'full'. Alias inline is tagged cosmetic (it renames
        // references without exposing new dead code), and 'dce' — the default — skips cosmetic passes.
        output: { minify: { compress: true } },
    });
    return r.code;
};

describe('alias inline — substitution', () => {
    it('rewrites every read of a multi-use alias and drops the declarator', async () => {
        const code = await build(
            'function f(a) {\n  const b = a;\n  return b + b * b;\n}\nglobalThis.sink = f(3);\n',
        );
        expect(code).not.toMatch(/\bb =/);
        expect(code).toContain('a + a * a');
    });

    it('rewrites a single-use alias too (path 1 only handles the ADJACENT case)', async () => {
        const code = await build(
            'function f(a) {\n  const b = a;\n  globalThis.gap = 1;\n  return b;\n}\nglobalThis.sink = f(7);\n',
        );
        expect(code).not.toMatch(/\bb =/);
        expect(code).toMatch(/, a;/); // the gap statement joined into a sequence, then the alias
    });

    it('resolves an alias chain a → b → c across fixed-point iterations', async () => {
        const code = await build(
            'function f(a) {\n  const b = a;\n  const c = b;\n  return c + c;\n}\nglobalThis.sink = f(2);\n',
        );
        expect(code).not.toMatch(/\bb =/);
        expect(code).not.toMatch(/\bc =/);
        expect(code).toContain('a + a');
    });

    it('aliases a parameter, a function declaration and a class', async () => {
        const code = await build(
            'function g() { return 1; }\nclass K {}\nfunction f(p) {\n' +
                '  const b = p, h = g, C = K;\n  return b + h() + (new C() ? 1 : 0);\n}\n' +
                'globalThis.sink = f(1);\n',
        );
        expect(code).not.toMatch(/\bb =/);
        expect(code).toContain('p + g()');
    });
});

describe('alias inline — refusals (each guards a miscompile)', () => {
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
