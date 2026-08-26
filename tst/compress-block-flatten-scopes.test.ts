import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// `blockFlatten` lifts a bare `{ … }` into its enclosing statement list. The block's SCOPE disappears
// with it, so `semantic.symbols[sym].scope` must be repointed at the target scope and any nested scope
// reparented — otherwise the semantic describes a scope tree the AST no longer has.
//
// Leaving it stale shipped TWO miscompiles from VALID input. Neither corpus reproduces them (crashcat
// and three.core.js both come out byte-identical either way), so these tests are the only thing
// standing between the fix and a silent regression.
const build = async (src: string): Promise<string> => {
    const r = await bundle({
        entry: '/e.js',
        fs: createMemoryFs({ '/e.js': src }),
        external: [],
        output: { minify: true, optimize: true },
    } as never);
    return (r as { code: string }).code;
};
const run = (code: string, input: unknown): Record<string, unknown> => {
    const g: Record<string, unknown> = { input };
    new Function('globalThis', code)(g);
    return g;
};

describe('blockFlatten keeps the semantic in step with the tree', () => {
    it('does not collide a lifted binding with a top-level function (was a duplicate declaration)', async () => {
        // `y` lifts to the scope holding `f`. With a stale `symbols[y].scope` the mangler saw no
        // overlap and named both `e`, emitting `function e(t){…} let e = e(…)` — a SyntaxError.
        const code = await build(
            'function f(a) { return a + 1; }\n{ let y = f(Number(globalThis.input)); globalThis.sink = y; }\n',
        );
        expect(run(code, 21).sink).toBe(22);
    });

    it('does not drop a lifted declaration that is still referenced (was tree-shaken away)', async () => {
        // treeshake decides top-level liveness from `symbols[sym].scope`. A lifted binding that still
        // claimed the vanished block scope was not treated as module-scope, so its declaration was
        // dropped while the reference to it survived as an undefined global.
        const code = await build(
            'const x = Number(globalThis.input);\n{ let y = x * 2; let z = y + 1; globalThis.sink = z; }\n',
        );
        expect(run(code, 21).sink).toBe(43);
    });

    it('survives nesting deeper than the compress loop can fold', async () => {
        // With MAX_ITERS = 8 the chain cannot fold to a literal, so the declarations must SURVIVE
        // rather than be dropped. Below the cap the fold hid the bug entirely, which is why it went
        // unnoticed: depth 7 was correct and depth 8 was not.
        const DEPTH = 12;
        let src = 'let v0 = Number(globalThis.input);\n';
        for (let i = 1; i <= DEPTH; i++) src += `{ let v${i} = v${i - 1} + 1;\n`;
        src += `globalThis.sink = v${DEPTH};\n` + '}'.repeat(DEPTH);
        const code = await build(src);
        expect(run(code, 100).sink).toBe(100 + DEPTH);
    });

    it('keeps two sibling blocks declaring the same name apart', async () => {
        // The pre-existing rename path — exercised here so the scope repointing did not break it.
        const code = await build(
            'globalThis.out = [];\n{ let n = Number(globalThis.input); globalThis.out.push(n); }\n{ let n = Number(globalThis.input) + 1; globalThis.out.push(n); }\nglobalThis.sink = globalThis.out.join(",");\n',
        );
        expect(run(code, 5).sink).toBe('5,6');
    });
});
