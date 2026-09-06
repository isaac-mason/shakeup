import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// Two `for...of` head restrictions, both keyed on the token the head STARTS with. oxc captures them
// the same way, before parsing the init expression (`js/statement.rs:471-493`), and both were
// verified against `oxc-parser` on 14 shapes before being written.
//
//   · `for (async of xs)` is forbidden — it would be ambiguous with `for await`.
//   · `for (let.x of xs)` is forbidden — a `for...of` head may not START with `let`.
const accepts = (src: string): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' }).errors.length === 0;

describe('`for...of` head restrictions', () => {
    it('rejects a bare `async` on the left', () => {
        expect(accepts('var async; for (async of [1]) ;')).toBe(false);
    });

    it('rejects a head starting with `let`', () => {
        expect(accepts('for (let.x of [1]) ;')).toBe(false);
    });

    it('exempts the three cases oxc exempts', () => {
        // An ESCAPED `async` is a plain identifier, so the ambiguity with `for await` is gone; only a
        // BARE identifier counts, so a member expression is fine; and under `for await` there is no
        // ambiguity to protect against.
        expect(accepts('var async; for (\\u0061sync of [1]) ;'), 'escaped').toBe(true);
        expect(accepts('var async; for (async.x of [1]) ;'), 'member').toBe(true);
        expect(accepts('async function f(){ var async; for await (async of [1]) ; }'), 'for await').toBe(true);
    });

    it('treats an ESCAPED `let` as an ordinary identifier — where oxc does not, and node agrees', () => {
        // A DELIBERATE divergence from oxc, checked against node because the two oracles disagree.
        // oxc guards its `async` rule with `!cur_token().escaped()` but its `let` rule with nothing,
        // so it rejects `for (l\u0065t.x of [1])`. node ACCEPTS that and rejects the unescaped form,
        // exactly as it does for `async`. shakeup's lexer leaves an escaped identifier as `T_IDENT`
        // and never the keyword kind, so it gets node's answer for both without a per-site guard.
        expect(accepts('for (l\\u0065t.x of [1]) ;'), 'escaped let — node accepts').toBe(true);
        expect(accepts('for (let.x of [1]) ;'), 'bare let — node rejects').toBe(false);
    });

    it('does not fire for `for...in`, or outside a for head', () => {
        for (const src of [
            'var async; for (async in {}) ;',
            'for (let in {}) ;',
            'for (let x in {}) ;',
            'var async; for (async = 1;;) ;',
            'var async; for (async;;) ;',
            'for (let x of [1]) ;',
            'var a; for (a of [1]) ;',
            'var o; for (o.let of [1]) ;', // `let` not at the START of the head
            'var async; for ((async) of [1]) ;', // the head starts with `(`
        ])
            expect(accepts(src), src).toBe(true);
    });
});
