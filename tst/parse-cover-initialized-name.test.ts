import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// `{ bar = baz }` is the spec's CoverInitializedName. The grammar has to accept it while parsing,
// because the same source could still turn out to be a destructuring PATTERN — but as a plain object
// literal, "It is a Syntax Error if any source text is matched by this production"
// (PropertyDefinition). shakeup accepted it everywhere.
//
// Both oracles reject: node says "Invalid shorthand property initializer", oxc says "Invalid
// assignment in object literal" (`diagnostics::cover_initialized_name`). oxc's mechanism is
// record-and-clear — note the property in `state.cover_initialized_name`, remove it when the cover
// grammar converts the object (`js/grammar.rs:227`), report whatever is left from
// `check_unfinished_errors`. shakeup validates rather than converts, so it records the LEGITIMISED
// offsets instead of deleting, and reports the difference at end of parse.
//
// rollupsuite's `catch-rust-panic-parse` is `this.parse('const foo = { bar = baz };')` expecting a
// throw.
const accepts = (src: string): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'module' }).errors.length === 0;

describe('CoverInitializedName', () => {
    it('is rejected in an ordinary object literal', () => {
        for (const src of [
            'const foo = { bar = baz };',
            '({ a = 1 });',
            'f({ a = 1 });',
            'let o = { a = 1, b: 2 };',
            'export const o = { a = 1 };',
        ])
            expect(accepts(src), src).toBe(false);
    });

    it("names the property, and uses oxc's wording", () => {
        const r = parseWithDiagnostics('const foo = { bar = baz };', { ts: false, jsx: false, kind: 'module' });
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].msg).toBe('Invalid assignment in object literal');
        expect(r.errors[0].pos, 'points at the property, as oxc does').toBe(14);
    });

    it('is accepted wherever the object IS a destructuring target', () => {
        for (const src of [
            '({ a = 1 } = x);',
            '[{ a = 1 }] = x;',
            'const { a = 1 } = x;',
            '({ a = 1 }) => a;',
            'for ({ a = 1 } of xs) ;',
            '({ a: { b = 1 } } = x);',
            'function f({ a = 1 }) {}',
            'try {} catch ({ a = 1 }) {}',
        ])
            expect(accepts(src), src).toBe(true);
    });

    it('one legal use does not legitimise an illegal one elsewhere', () => {
        // The record is keyed by OFFSET, so two occurrences must be tracked apart. A set-of-names or
        // a single boolean would let the first case mask the second.
        expect(accepts('({ a = 1 } = x); ({ a = 1 });')).toBe(false);
        expect(accepts('({ a = 1 }); ({ a = 1 } = x);')).toBe(false);
        expect(accepts('({ a = 1 } = x); ({ b = 2 } = y);')).toBe(true);
    });
});
