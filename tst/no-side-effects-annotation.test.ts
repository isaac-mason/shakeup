import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// `/*@__NO_SIDE_EFFECTS__*/` asserts that CALLING the annotated function is side-effect-free,
// whatever its body does — rollup returns false from `hasEffects` outright; rolldown carries it as
// `SymbolRefFlags::SideEffectsFreeFunction`. We had NO support at all, so the ~26 annotations in a
// `bongle` build did nothing.
//
// Modelled on rolldown's shape (a SYMBOL flag) rather than rollup's node-level one, because
// cross-module purity here is already keyed by symbol: an annotated function is simply a summary of
// `{ impure: false, callees: ∅ }`, which flows through the existing solve/stamp — including across
// modules, since summaries are keyed by `packRef` and the resolver already follows imports.
const A = '/*@__NO_SIDE_EFFECTS__*/';
// IMPURE bodies throughout: only the annotation can license dropping the call.
const BODY = '{ globalThis.hit = 1; return x; }';

const dropsCall = async (lib: string): Promise<boolean> => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({
            '/main.js': "import { api } from './lib.js';\nconst unused = api(1);\nexport const keep = 1;\n",
            '/lib.js': `${lib}\n`,
        }),
    });
    expect(r.errors).toEqual([]);
    return !/api\(/.test(r.code);
};

describe('@__NO_SIDE_EFFECTS__', () => {
    it.each([
        ['before an exported function declaration', `${A}\nexport function api(x) ${BODY}`],
        ['before a local function declaration', `${A}\nfunction api(x) ${BODY}\nexport { api };`],
        ['on an arrow initialiser', `export const api = ${A} (x) => ${BODY};`],
        ['before a const declaration', `${A}\nexport const api = (x) => ${BODY};`],
        ['on a function expression', `export const api = ${A} function (x) ${BODY};`],
    ])('drops a cross-module call — %s', async (_name, lib) => {
        expect(await dropsCall(lib)).toBe(true);
    });

    it('leaves an UNANNOTATED impure function alone', async () => {
        expect(await dropsCall(`export function api(x) ${BODY}`)).toBe(false);
    });

    it('still requires the ARGUMENTS to be effect-free', async () => {
        // The annotation is about the callee, not the call expression: an impure argument is still
        // evaluated, so the call cannot be dropped. Same rule `@__PURE__` follows.
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js':
                    "import { api } from './lib.js';\nfunction boom() { globalThis.arg = 1; return 1; }\n" +
                    'const unused = api(boom());\nexport const keep = 1;\n',
                '/lib.js': `${A}\nexport function api(x) ${BODY}\n`,
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('boom(');
    });

    it('a module-local call is dropped too', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js': `${A}\nfunction api(x) ${BODY}\nconst unused = api(1);\nexport const keep = 1;\n`,
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('api(');
    });

    it('a CALLED annotated function is still emitted', async () => {
        // The assertion licenses dropping an UNUSED call, not deleting the function outright.
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js': "import { api } from './lib.js';\nexport const used = api(1);\n",
                '/lib.js': `${A}\nexport function api(x) ${BODY}\n`,
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('api(');
    });
});
