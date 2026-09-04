import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';

// `output.generatedCode.symbols` — rolldown's option (`generated_code_options.rs`), and one of the
// few places the two oracles disagree on a DEFAULT rather than on behaviour: rolldown's default is
// `true` (`GeneratedCodeOptions::default() == es2015()`), Rollup's is `false` (`es5`). shakeup's
// bundler follows rolldown, so `true` is the default here.
//
// Both emission paths have to honour it. The ordinary namespace object stamps the tag with a separate
// `Object.defineProperty` (a literal member would be enumerable and get copied by `{...ns}`); the
// dynamic-exports form hands its members to `__exportAll`, whose runtime stamps the tag itself and
// takes a `no_symbols` second argument to suppress it — the same shape and the same polarity as
// rolldown's `module_finalizers/mod.rs:993`.
const files: Record<string, string> = {
    '/dep.js': 'export const a = 1;\nexport const b = 2;\n',
    '/main.js': "import * as ns from './dep.js';\nexport const got = ns.a + ns.b;\n",
    // `export *` from CommonJS makes the surface unknowable statically, which is what routes the
    // namespace through `__exportAll` instead of an object literal.
    '/cjs.cjs': 'exports.x = 1;\n',
    '/mid.js': "export * from './cjs.cjs';\nexport const own = 3;\n",
    '/mainCjs.js': "import * as ns from './mid.js';\nexport const got = ns.own;\n",
};
const memFs = {
    read: (id: string) => files[id] ?? null,
    exists: (id: string) => id in files,
};
const build = (entry: string, symbols?: boolean) =>
    bundle({
        entry,
        fs: memFs,
        external: [],
        output: symbols === undefined ? {} : { generatedCode: { symbols } },
    }).then((r) => {
        expect(r.errors).toEqual([]);
        return r.chunks[0].code;
    });

describe('output.generatedCode.symbols', () => {
    it('defaults to TRUE, which is rolldown’s default and not Rollup’s', async () => {
        expect(await build('/main.js')).toContain('Symbol.toStringTag');
    });

    it('symbols:false drops the tag from an object-literal namespace', async () => {
        expect(await build('/main.js', false)).not.toContain('Symbol.toStringTag');
    });

    it('symbols:true is the same as the default', async () => {
        expect(await build('/main.js', true)).toBe(await build('/main.js'));
    });

    it('passes `no_symbols` to __exportAll rather than dropping the runtime helper', async () => {
        // The helper still ships — it is what builds the object — so the ONLY difference is the
        // second argument. Asserting on the call, not on the absence of the string, because the
        // runtime's own source contains `Symbol.toStringTag` either way.
        const on = await build('/mainCjs.js', true);
        const off = await build('/mainCjs.js', false);
        expect(on).toMatch(/__exportAll\(\{[^}]*\}\);/);
        expect(off).toMatch(/__exportAll\(\{[^}]*\}, 1\);/);
    });

    it('the tag is observable at runtime, and only when it is on', async () => {
        for (const [symbols, want] of [
            [true, '[object Module]'],
            [false, '[object Object]'],
        ] as const) {
            const code = (await build('/main.js', symbols)).replace(/^export /gm, '');
            // biome-ignore lint/security/noGlobalEval: test-only evaluation of generated code
            const tag = new Function(`${code}\nreturn Object.prototype.toString.call(dep_ns ?? ns);`)();
            expect(tag, `symbols:${symbols}`).toBe(want);
        }
    });
});
