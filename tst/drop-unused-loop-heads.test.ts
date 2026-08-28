import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// A reported miscompile, reduced to one function:
//
//     export function f(b) { let n = 0; for (const _ in b) { n += 1; } return n; }
//
// `dropUnused` saw a dead `let`/`const` binding and called `ctx.remove()` on its declaration. But a
// `let`/`const` declaration reaches a SINGLE-CHILD slot in exactly three places — `ForStatement.init`,
// `ForInStatement.left`, `ForOfStatement.left` — and `remove()` is illegal in all of them, so the
// build died with "remove()/replaceWithMultiple() not allowed in a single-child slot". No plugins,
// no define, no minify: `bundle()` over a memory fs was enough.
//
// The report named for-in and for-of. `for (;;)` heads were hit too, and worse: there the
// `DROP_IMPURE` path wrote an `ExpressionStatement` into the `init` EXPRESSION slot and did NOT
// throw — it produced a tree the printer later rejected with "unsupported expression node
// ExpressionStatement". A corrupt AST is the more dangerous half of the same bug.
//
// `var` was unaffected only because `var` is hard-bailed before any of this.
const build = (src: string, minify = false) =>
    bundle({ entry: '/e.js', external: [], fs: createMemoryFs({ '/e.js': src }), output: { minify } });

const run = async (src: string) => {
    const r = await build(src, true);
    expect(r.errors).toEqual([]);
    return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as Record<string, unknown>;
};

describe('dropUnused: a declaration in a loop head', () => {
    it.each([
        ['for-in, unused const', 'export function f(b){let n=0;for(const _ in b){n+=1;}return n;}'],
        ['for-of, unused const', 'export function f(b){let n=0;for(const _ of b){n+=1;}return n;}'],
        ['for-in, unused let', 'export function f(b){let n=0;for(let _ in b){n+=1;}return n;}'],
        ['for-in, unused var', 'export function f(b){let n=0;for(var _ in b){n+=1;}return n;}'],
        ['for-await-of, unused', 'export async function f(b){let n=0;for await(const _ of b){n+=1;}return n;}'],
        ['labelled for-in', 'export function f(b){let n=0;L:for(const _ in b){n+=1;}return n;}'],
        ['for-in as a bare `if` body', 'export function f(b,c){let n=0;if(c)for(const _ in b)n+=1;return n;}'],
        ['for(;;), unused pure init', 'export function f(){let n=0;for(let _=0;n<3;n++){n+=1;}return n;}'],
        ['for(;;), unused impure init', 'export function f(g){let n=0;for(let _=g();n<3;n++){n+=1;}return n;}'],
        ['for(;;), one of two dead', 'export function f(){let n=0;for(let _=0,q=0;q<3;q++){n+=1;}return n;}'],
        ['for-of, destructured', 'export function f(b){let n=0;for(const [_] of b){n+=1;}return n;}'],
    ])('builds: %s', async (_label, src) => {
        const r = await build(src, true);
        expect(r.errors).toEqual([]);
    });

    it('keeps the binding a for-in head REQUIRES', async () => {
        // `for (in b)` does not parse, so the declaration is not removable at any price. oxc emits
        // `for (let _ in b)` for exactly this input — it keeps it too.
        const r = await build('export function f(b){let n=0;for(const _ in b){n+=1;}return n;}', true);
        expect(r.code).toMatch(/for\s*\(\s*(?:const|let|var)\s+\w+\s+in\b/);
        const m = (await run('export function f(b){let n=0;for(const _ in b){n+=1;}return n;}')) as { f: (o: object) => number };
        expect(m.f({ a: 1, b: 2, c: 3 })).toBe(3);
    });

    it('DOES drop a `for(;;)` init clause, which is optional', async () => {
        // The one loop head where a removal is expressible — and it has to be done from the parent
        // (`init = null`), not by unlinking the declaration. oxc emits `for (; n < 3; n++)`.
        const r = await build('export function f(){let n=0;for(let _=0;n<3;n++){n+=1;}return n;}', true);
        expect(r.code).toMatch(/for\s*\(\s*;/);
        const m = (await run('export function f(){let n=0;for(let _=0;n<3;n++){n+=1;}return n;}')) as { f: () => number };
        expect(m.f()).toBe(4); // body adds 1, update adds 1 → 0, 2, 4
    });

    it('prunes only the dead declarator when a sibling in the head is live', async () => {
        const r = await build('export function f(){let n=0;for(let _=0,q=0;q<3;q++){n+=1;}return n;}', true);
        expect(r.code).not.toMatch(/for\s*\(\s*;/); // the head survives…
        expect(/for\s*\(\s*let\s+[^;]*,/.test(r.code)).toBe(false); // …with one declarator, not two
        const m = (await run('export function f(){let n=0;for(let _=0,q=0;q<3;q++){n+=1;}return n;}')) as { f: () => number };
        expect(m.f()).toBe(3);
    });

    it('prunes a dead PURE declarator even when an impure sibling stays', async () => {
        // oxc's predicate is PER-DECLARATOR (`minimize_statements.rs:1048` — `retain_mut`, keep when
        // live OR the init has side effects), not per-clause. Bailing the whole head on any impure
        // sibling is the obvious conservative reading and is NOT what oxc does: for
        // `for (let _ = g(), q = 0; …)` with both dead it emits `for (let _ = g(); …)`.
        for (const src of [
            'export function f(g){let n=0;for(let _=g(),q=0;n<3;n++){n+=1;}return n;}',
            'export function f(g){let n=0;for(let q=0,_=g();n<3;n++){n+=1;}return n;}',
        ]) {
            const r = await build(src, true);
            expect(r.errors).toEqual([]);
            expect(/for\s*\(\s*let\s+[^;]*,/.test(r.code), src).toBe(false); // one declarator left…
            expect(r.code, src).toMatch(/for\s*\(\s*let\s+\w+\s*=\s*\w+\(\)/); // …and it is the impure one
        }
        // Two impure dead declarators: both survive, in oxc too.
        const both = await build('export function f(g,h){let n=0;for(let _=g(),z=h();n<3;n++){n+=1;}return n;}', true);
        expect(/for\s*\(\s*let\s+[^;]*,/.test(both.code)).toBe(true);
    });

    it('never drops an IMPURE init, and runs it exactly once', async () => {
        // The corrupt-AST half. oxc keeps `for (let _ = g(); …)` whole rather than demoting the init
        // to a bare `g()`, and matching that is what keeps a statement out of an expression slot.
        const m = (await run('export function f(g){let n=0;for(let _=g();n<3;n++){n+=1;}return n;}')) as {
            f: (g: () => number) => number;
        };
        let calls = 0;
        expect(
            m.f(() => {
                calls++;
                return 0;
            }),
        ).toBe(4);
        expect(calls).toBe(1);
    });

    it('still drops an unused binding OUTSIDE a loop head', async () => {
        // The guard must be narrow: it protects loop heads, not every declaration.
        const r = await build('export function f(){const _=1;let n=0;n+=1;return n;}', true);
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/=\s*1\s*[,;]\s*\w+\s*=\s*0/);
    });
});
