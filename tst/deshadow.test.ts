import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// DESHADOWING. Deconfliction gives top-level symbols their final names but says nothing about the
// scopes those names are READ from. When an import lands on a name that a nested scope also binds,
// every reference to the import inside that scope silently binds to the LOCAL instead:
//
//     import { foo as _foo } from './lib.js';
//     function g(foo) { return _foo(); }     ->     function g(foo) { return foo(); }
//
// Silent miscompiles, not missed optimisations. Three of rollup's samples hit it
// (`deshadows-function-expression-id`, `deshadowed-namespaced-import-renamed`,
// `namespacing-in-sub-functions`), where a named function expression's own id captured the import
// and recursed until the stack blew.
//
// The fix renames the INNER binding, following rollup (`ChildScope.deconflict`) — reserving every
// local name globally would also be correct but would push a `$1` onto vast numbers of top-level
// symbols.
const LIB = "export function foo() { return 'works'; }";

const evalR = async (src: string, minify = false): Promise<unknown> => {
    const r = await bundle({
        entry: '/main.js',
        fs: createMemoryFs({ '/main.js': src, '/lib.js': LIB }),
        output: minify ? { minify: true } : {},
    });
    expect(r.errors).toEqual([]);
    return ((await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { r: unknown }).r;
};

describe('a nested binding never captures an import renamed onto its name', () => {
    const CASES: [string, string][] = [
        // The rollup sample: the function expression's own id binds `foo` inside its body, so the
        // call became infinite recursion rather than a wrong value.
        [
            'named function expression id',
            "import { foo as _foo } from './lib.js';\nexport const r = (function foo() { return _foo(); })();",
        ],
        [
            'function parameter',
            "import { foo as _foo } from './lib.js';\nfunction g(foo) { return _foo(); }\nexport const r = g(1);",
        ],
        [
            'catch parameter',
            "import { foo as _foo } from './lib.js';\nfunction g() { try { throw 0; } catch (foo) { return _foo(); } }\nexport const r = g();",
        ],
        [
            'class expression id',
            "import { foo as _foo } from './lib.js';\nexport const r = (new (class foo { m() { return _foo(); } })()).m();",
        ],
        // A local that is actually USED — the earlier probe used an unused `let`, which was
        // tree-shaken away and so appeared to pass without the fix.
        [
            'used local binding',
            "import { foo as _foo } from './lib.js';\nfunction g() { let foo = 1; return _foo() + foo; }\nexport const r = g();",
        ],
    ];

    it.each(CASES)('%s', async (_name, src) => {
        const expected = src.includes('+ foo') ? 'works1' : 'works';
        expect(await evalR(src)).toBe(expected);
    });

    it.each(CASES)('%s (minified)', async (_name, src) => {
        const expected = src.includes('+ foo') ? 'works1' : 'works';
        expect(await evalR(src, true)).toBe(expected);
    });
});
