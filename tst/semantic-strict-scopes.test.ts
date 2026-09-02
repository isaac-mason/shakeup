// Strict mode lives on the SCOPE, not on a parser flag, because it ACCUMULATES: a `"use strict"`
// inside one function makes that function and everything nested in it strict while its siblings stay
// sloppy. oxc's parser has no strict bit at all for this reason — its only `is_strict` is a property
// of the FILE — and every strict-mode early error lives in `oxc_semantic`'s checker, gated on
// `ctx.strict_mode()` = `current_scope_flags().is_strict_mode()` (`builder.rs:529`).
//
// This is the substrate the checker layer needs (ROADMAP §2b, `checker-layer-plan.md` P1). It carries
// no rules yet; it is tested directly on the scope flags rather than through a rule, because the
// propagation IS the thing that has to be right and an indirect test would hide which seed failed.
//
// Three seeds, and nothing turns strictness back off:
//   · the module goal        — an ES module is strict by definition
//   · a `"use strict"` prologue — of the program, or of a single function body
//   · a class body           — always strict, however it is reached
import { describe, expect, it } from 'vitest';
import { analyze, createSemantic, SCOPE, SCOPE_STRICT, scopeKind } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

/** Every scope as `kind:strict`, in creation order, skipping the null sentinel at index 0. */
const scopesOf = (src: string, isModule = false) => {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program, isModule);
    return sem.scopes.slice(1).map((s) => ({ kind: scopeKind(s.flags), strict: (s.flags & SCOPE_STRICT) !== 0 }));
};

describe('the seeds', () => {
    it('a script is sloppy', () => {
        expect(scopesOf('function f(){}').every((s) => !s.strict)).toBe(true);
    });

    it('a module is strict throughout', () => {
        expect(scopesOf('function f(){ { let a; } }', true).every((s) => s.strict)).toBe(true);
    });

    it('a program-level "use strict" makes everything strict', () => {
        expect(scopesOf('"use strict"; function f(){}').every((s) => s.strict)).toBe(true);
    });

    it('a class body is strict even in a sloppy script', () => {
        const scopes = scopesOf('class C { m(){} }');
        const cls = scopes.find((s) => s.kind === SCOPE.CLASS);
        expect(cls?.strict).toBe(true);
        // and the method inside it inherits
        expect(scopes.filter((s) => s.kind === SCOPE.FUNCTION).every((s) => s.strict)).toBe(true);
    });
});

describe('it accumulates, and never turns off', () => {
    it('a directive in ONE function leaves its sibling sloppy', () => {
        const fns = scopesOf('function a(){ "use strict"; } function b(){}').filter((s) => s.kind === SCOPE.FUNCTION);
        expect(fns).toHaveLength(2);
        expect(fns[0].strict).toBe(true);
        expect(fns[1].strict).toBe(false);
    });

    it('and everything nested inside a strict function is strict', () => {
        const scopes = scopesOf('function a(){ "use strict"; function inner(){ { let x; } } }');
        expect(scopes.slice(1).every((s) => s.strict)).toBe(true);
    });

    it('a nested "use strict" cannot be undone by an inner function', () => {
        const fns = scopesOf('"use strict"; function a(){ function b(){} }').filter((s) => s.kind === SCOPE.FUNCTION);
        expect(fns.every((s) => s.strict)).toBe(true);
    });
});

describe('what is NOT a directive', () => {
    // The RAW text decides. `"use strict"` spells the same string and is not a directive — a
    // classic subtlety, and the reason the check reads `StringLiteral.name` (the source slice with its
    // quotes) rather than any cooked value.
    it('an escaped spelling is not a directive', () => {
        expect(scopesOf('"use\\u0020strict"; function f(){}').every((s) => !s.strict)).toBe(true);
    });

    it('a directive after a real statement is not a prologue', () => {
        expect(scopesOf('var x = 1; "use strict"; function f(){}').every((s) => !s.strict)).toBe(true);
    });

    it('but a directive after ANOTHER string directive still counts', () => {
        expect(scopesOf('"use asm"; "use strict"; function f(){}').every((s) => s.strict)).toBe(true);
    });

    it("single quotes count too", () => {
        expect(scopesOf("'use strict'; function f(){}").every((s) => s.strict)).toBe(true);
    });
});
