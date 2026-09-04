import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundler/bundle.ts';
import { createMemoryFs } from '../src/bundler/fs.ts';

// A switch statement's BODY is a block scope; its DISCRIMINANT is not in it. oxc makes the order
// explicit in `visit_switch_statement`: `visit_expression(&stmt.discriminant)` runs first, and only
// then `enter_scope(ScopeFlags::empty(), &stmt.scope_id)`.
//
// shakeup visited the discriminant inside that scope, so `switch (foo)` bound to a `const foo`
// declared in one of the cases. It compiled to `switch (2)` — the case stopped matching and the
// body never ran. A silent wrong answer, not a crash. rollupsuite's `switch-scope`; node agrees the
// program is legal and prints `triggered = true`.
const build = async (src: string) => {
    const r = await bundle({ entry: '/main.js', fs: createMemoryFs({ '/main.js': src }), external: [] } as never);
    expect(r.errors).toEqual([]);
    return r.chunks.map((c) => c.code).join('\n');
};
const run = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

describe("a switch's discriminant is outside the switch's scope", () => {
    it('does not bind to a `const` declared in a case', async () => {
        const code = await build(
            [
                'const foo = 1;',
                'let triggered = false;',
                'switch (foo) {',
                '\tcase 1:',
                '\t\tconst foo = 2;',
                '\t\ttriggered = true;',
                '}',
                'export const t = triggered;',
            ].join('\n'),
        );
        expect(code, 'the discriminant is the OUTER foo').not.toContain('switch (2)');
        expect((await run(code)).t).toBe(true);
    });

    it('a `let` in a case still shadows inside the body', async () => {
        const code = await build(
            [
                'const x = 1;',
                'let seen = 0;',
                'switch (x) {',
                '\tcase 1: {',
                '\t\tlet x = 9;',
                '\t\tseen = x;',
                '\t}',
                '}',
                'export const s = seen;',
                'export const o = x;',
            ].join('\n'),
        );
        const mod = await run(code);
        expect(mod.s, 'the case body sees its own x').toBe(9);
        expect(mod.o, 'the outer x is untouched').toBe(1);
    });

    it('a case can still reference an outer binding', async () => {
        const code = await build(
            ['const n = 3;', 'let out = 0;', 'switch (1) {', '\tcase 1:', '\t\tout = n;', '}', 'export const o = out;'].join(
                '\n',
            ),
        );
        expect((await run(code)).o).toBe(3);
    });
});
