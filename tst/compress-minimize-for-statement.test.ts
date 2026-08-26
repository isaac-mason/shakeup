import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// oxc `minimize_for_statement` (a port of esbuild's `mangleFor`) plus the constant-operand logical
// fold (`try_fold_and_or`) it depends on to finish the job.
//
//   for (;;)   if (x) break;           →  for (; !x;) ;
//   for (; a;) if (x) break; else y(); →  for (; a && !x;) y();
//   for (; a;) if (x) y(); else break; →  for (; a && x;) y();
//
// The two land together because `normalize` rewrites `while (true)` to `for (; !0;)`, so without the
// fold every hoisted test kept a dead `!0 &&` in front of it forever.
const build = async (body: string): Promise<string> => {
    const r = await bundle({
        entry: '/e.js',
        fs: createMemoryFs({ '/e.js': body }),
        external: [],
        output: { minify: true, optimize: true },
    } as never);
    return (r as { code: string }).code;
};
const run = (code: string): unknown => {
    const g: Record<string, unknown> = {};
    new Function('globalThis', code)(g);
    return g.sink;
};

describe('a leading `if (…) break;` hoists into the loop test', () => {
    it('drops the loop body entirely when the if is the whole body', async () => {
        const code = await build('let o = 0;\nwhile (true) { o++; if (o > 3) break; }\nglobalThis.sink = o;');
        expect(code).not.toContain('break');
        expect(code).not.toMatch(/!0\s*&&/); // the `while (true)` test folded away
        expect(run(code)).toBe(4);
    });

    it('keeps the else branch as the new body', async () => {
        const code = await build(
            'let o = 0, n = 0;\nwhile (true) { if (o > 2) break; else n += o; o++; }\nglobalThis.sink = n;',
        );
        expect(run(code)).toBe(3); // 0 + 1 + 2
    });

    it('handles the inverted shape (`if (x) y(); else break;`)', async () => {
        const code = await build(
            'let o = 0, n = 0;\nwhile (true) { if (o < 3) n += o; else break; o++; }\nglobalThis.sink = n;',
        );
        expect(run(code)).toBe(3);
    });

    it('does NOT hoist a LABELLED break', async () => {
        // A labelled break may target an OUTER loop, so hoisting it into THIS loop's test would change
        // which loop exits.
        const code = await build(
            'let n = 0;\nouter: for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) { if (j > 0) break outer; n++; } }\nglobalThis.sink = n;',
        );
        expect(run(code)).toBe(1);
    });
});

describe('a logical with a constant left operand folds (oxc try_fold_and_or)', () => {
    it.each([
        ['true && x', 4],
        ['!0 && x', 4],
        ['false || x', 4],
        ['!1 || x', 4],
    ])('%s', async (expr, want) => {
        const code = await build(`const x = 4;\nglobalThis.sink = ${expr};`);
        expect(run(code)).toBe(want);
    });

    it('keeps the constant when it short-circuits', async () => {
        expect(run(await build('globalThis.sink = false && 4;'))).toBe(false);
        expect(run(await build('globalThis.sink = true || 4;'))).toBe(true);
    });

    it('leaves `??` alone — it tests NULLISH, not truthiness', async () => {
        // `0 ?? x` is 0, whereas `0 || x` is x. Folding it as a truthiness test would be wrong.
        expect(run(await build('globalThis.sink = 0 ?? 4;'))).toBe(0);
    });
});
