import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// Annex B B.3.5 lets a `var` redeclare a catch parameter — but only "if CatchParameter is
// CatchParameter:BindingIdentifier". So `catch (e) { var e; }` is legal and `catch ([e]) { var e; }`
// is an error, and once the pattern's names are bound the two are indistinguishable. shakeup's
// hoist-past walk treated every catch binding as a "COMPATIBLE binding on the way up", which is the
// exemption applied unconditionally.
//
// A `SYM.CATCH_PATTERN` flag records which form the parameter took. Verified against `oxc-parser` AND
// node on 13 shapes — both oracles agree on every one.
const check = (src: string): boolean => {
    const p = parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' });
    if (p.errors.length > 0) return false;
    const sem = createSemantic();
    analyze(sem, p.program, false, true);
    return sem.errors.length === 0;
};

describe("Annex B's var-over-catch exemption is for a plain identifier only", () => {
    it('rejects a `var` that redeclares a DESTRUCTURING catch parameter', () => {
        for (const src of [
            'try {} catch ([x]) { var x; }',
            'try {} catch ({x}) { var x; }',
            'try {} catch ({a: x}) { var x; }',
            'try {} catch ([x = 1]) { var x; }',
            'try {} catch ([x]) { { var x; } }', // however deep the `var` sits
        ])
            expect(check(src), src).toBe(false);
    });

    it('still allows it for a SIMPLE catch parameter — that IS Annex B', () => {
        expect(check('try {} catch (x) { var x; }')).toBe(true);
        expect(check('try {} catch (x) { { var x; } }')).toBe(true);
    });

    it('leaves everything a pattern parameter does not collide with alone', () => {
        for (const src of [
            'try {} catch ([x]) { var y; }', // a different name
            'try {} catch ([x]) { function g(){ var x; } }', // a nested function has its own var scope
            'try {} catch ([x]) { let y; }',
            'try {} catch ([x]) { x; }', // a read, not a declaration
            'function f(){ var a; { var a; } }', // ordinary var hoisting still fine
        ])
            expect(check(src), src).toBe(true);
    });
});
