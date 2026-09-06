import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// Two context rules from `pnpm misslayers`' PARSER bucket, both verified against `oxc-parser` first.
const accepts = (src: string, kind: 'module' | 'unambiguous' = 'unambiguous'): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind }).errors.length === 0;

describe('`super` must be a call or a property access', () => {
    // `super` is only ever a SuperCall or a SuperProperty, so it must be followed by `(`, `.` or `[`.
    // The rule is purely SYNTACTIC at the parser layer: oxc's parser accepts
    // `function f() { super.x; }` and leaves "is there a home object" to its checker, so shakeup
    // does the same rather than inventing a stricter parser rule.
    it('rejects a bare `super`', () => {
        expect(accepts('super;', 'module'), 'module goal').toBe(false);
        expect(accepts('super;'), 'script goal').toBe(false);
        expect(accepts('class C extends D { m() { super; } }')).toBe(false);
    });

    it('rejects `super` followed by anything but a call or an access', () => {
        for (const src of ['class C extends D { m() { super`t`; } }', 'class C extends D { m() { super?.x; } }'])
            expect(accepts(src), src).toBe(false);
    });

    it('accepts the call and property forms', () => {
        for (const src of [
            'class C extends D { constructor() { super(); } }',
            'class C extends D { constructor() { super(...a); } }',
            'class C extends D { m() { super.x; } }',
            'class C extends D { m() { super["x"]; } }',
            'class C extends D { m() { super.x = 1; } }',
            'class C extends D { m() { (super.x); } }',
            '({ m() { super.x; } });',
            'function f() { super.x; }', // a CHECKER question, not a parser one — oxc accepts it too
        ])
            expect(accepts(src), src).toBe(true);
    });
});

describe('`return` inside a class static block', () => {
    // shakeup already had this rule but nested it inside a `fnDepth === 0` guard, so it only fired
    // for a class at the top level. A class can sit inside a function, and test262's
    // `static-init-invalid-return.js` is exactly that shape. `staticBlockDepth` is reset at every
    // function boundary, so a non-zero value already means the innermost body IS the static block.
    it('is rejected even when the class is inside a function', () => {
        expect(accepts('function f() { class C { static { return; } } }')).toBe(false);
        expect(accepts('class C { static { return; } }')).toBe(false);
        expect(accepts('class C { static { if (0) return; } }')).toBe(false);
    });

    it('is still allowed in a function nested inside the static block', () => {
        for (const src of [
            'class C { static { function g(){ return 1; } } }',
            'class C { static { () => { return 1; }; } }',
            'function f() { class C { static { function g(){ return; } } } }',
            'function f(){ return 1; }',
            'class C { m() { return 1; } }',
        ])
            expect(accepts(src), src).toBe(true);
    });
});
