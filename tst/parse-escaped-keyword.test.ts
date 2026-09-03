// An escaped spelling still NAMES the keyword: `yield` is `yield` for every reserved-word rule.
//
// oxc gets this almost for free. Its lexer gives the escaped token the KEYWORD's own `Kind`, so a
// single guard in the cursor covers every consumption site:
//
//     // cursor.rs:100
//     if self.token.escaped() && kind.is_any_keyword() { self.report_escaped_keyword(...) }
//
// shakeup's lexer keeps an escaped identifier as an identifier with `F_ESCAPED` + cooked text, so the
// rules consult the cooked name instead. That difference is why two holes existed at once:
//
//   · `yield`/`await` are CONTEXTUAL keywords, and the escaped check exempted all contextual
//     keywords — correct for `async`/`let`/`of`, wrong for the two that become reserved.
//   · a shorthand property never reached `parseIdent` at all, so `({ break })` was accepted even
//     UNESCAPED. That hole is the larger of the two and had nothing to do with escapes.
//
// Messages are oxc's, checked against `oxc-parser` case by case. The shorthand ones are "expected
// ':'" because that is genuinely what oxc reports — it parses the shorthand value as an
// IdentifierReference and its recovery then asks for the `:` that would have made the name a key.
// Binding a contextually-reserved word reports the CONTEXT rather than the escape, which is also
// oxc's ordering: `var await` in an async function is "cannot use `await` as an identifier".
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

// `import.meta` is MODULE-ONLY syntax — node says "Cannot use 'import.meta' outside a module", oxc
// "Unexpected import.meta expression". Gated on an EXPLICIT commonjs goal for the same reason
// `allowTopReturn` and `allowTopNewTarget` are: `unambiguous` stays permissive, so only a file with a
// real signal (`.cjs`/`.cts`, or a declared `package.json#type`) is held to it.
//
// These were the LAST findings in `pnpm parsercorpus`; closing them took that differential to 0 in
// BOTH directions across 4,441 node_modules files.
describe('import.meta outside a module', () => {
    const goalErrs = (src: string, kind: 'module' | 'commonjs' | 'unambiguous') =>
        parse(src, { ts: false, jsx: false, kind }).errors.map((e) => e.msg);

    it.each(['import.meta.url;', 'function f(){ return import.meta; }', 'new URL("a", import.meta.url);'])(
        'rejects %s under an explicit commonjs goal',
        (src) => {
            expect(goalErrs(src, 'commonjs')).toEqual(['Unexpected import.meta expression']);
        },
    );

    it.each(['import.meta.url;', 'import.meta;'])('accepts %s in a module', (src) => {
        expect(goalErrs(src, 'module')).toEqual([]);
    });

    it('stays permissive under the unambiguous default', () => {
        expect(goalErrs('import.meta.url;', 'unambiguous')).toEqual([]);
    });

    it('leaves dynamic import alone', () => {
        expect(goalErrs('import(x);', 'commonjs')).toEqual([]);
    });
});

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('a reserved word may not be a shorthand property', () => {
    it.each([
        'var o = { break };',
        'var o = { bre\\u0061k };',
        'var { break } = o;',
        'var { bre\\u0061k } = o;',
        'var x = ({ bre\\u0061k }) => {};',
        'var o = { this };',
        'var o = { class };',
        'var { break = 1 } = o;',
    ])('%s', rejects);

    it('reports what oxc reports', () => {
        expect(msg('var o = { break };')).toMatch(/expected ':'/);
    });

    it('a reserved word is still fine as a KEY', () => {
        expect(errs('var o = { break: 1, if: 2, this: 3, class: 4 };')).toEqual([]);
        expect(errs('x.bre\\u0061k;')).toEqual([]);
    });
});

describe('yield and await are contextual, and become reserved', () => {
    it('escaped, as a binding — reports the context', () => {
        expect(msg('async () => { var \\u0061wait; };')).toBe('cannot use `await` as an identifier in an async context');
        expect(msg('function* g() { var \\u0079ield; }')).toBe('cannot use `yield` as an identifier in a generator context');
    });

    it('escaped, as a reference — reports the escape', () => {
        expect(msg('async () => { void \\u0061wait; };')).toBe('keywords cannot contain escape characters');
        expect(msg('function* g() { \\u0079ield; }')).toBe('keywords cannot contain escape characters');
    });

    it('as a shorthand property', () => {
        expect(msg('async () => ({ await });')).toMatch(/expected ':'/);
        expect(msg('async () => ({ \\u0061wait });')).toMatch(/expected ':'/);
    });

    it('and are ordinary identifiers where they are NOT reserved', () => {
        expect(errs('function f() { var \\u0061wait; }')).toEqual([]);
        expect(errs('function f() { var \\u0079ield; }')).toEqual([]);
        expect(errs('var o = { yield, await };')).toEqual([]);
    });
});

describe('what stays legal', () => {
    // The contextual keywords that are never reserved. A false rejection here would break ordinary
    // code — `{ type }` and `{ as }` alone appear throughout real TS — so they are pinned explicitly
    // rather than left to `pnpm parsercorpus` to discover.
    it.each([
        'var o = { async };',
        'var o = { get };',
        'var o = { set };',
        'var o = { of };',
        'var o = { let };',
        'var o = { from };',
        'var o = { type };',
        'var o = { as };',
        'var o = { static };',
        'var o = { source };',
        'var o = { defer };',
        'var o = { meta };',
        'var { async, get, set, of, let } = o;',
        'var o = { async() {} };',
        'var o = { get x() { return 1; } };',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });
});
