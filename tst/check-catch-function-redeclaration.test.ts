import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// `catch (x) { function x(){} }` is an error, and shakeup carried it as a documented KNOWN GAP: "a
// function declaration hoists to the enclosing function scope, AND `declareInScope` has already moved
// `state.scope` into the function's own scope, so neither scope here is the catch body. Catching it
// needs the appearance scope threaded through, which is not worth the contortion."
//
// The appearance scope was already computed one line above, as `appearAt`. Instrumenting the scope
// chain showed both the `let` and the `function` case reach the SAME parent through it — the gap was
// reading `state.scope` where `appearAt` was meant. The second half is that `CATCH | FUNCTION` is not
// lexical by the flag matrix, so the recorded collision was then excused; a function written directly
// in the catch body is lexical there, so it is recorded as one.
//
// Both oracles reject it, in sloppy mode as well as strict — checked against node and `oxc-parser`.
const check = (src: string): boolean => {
    const p = parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' });
    if (p.errors.length > 0) return false;
    const sem = createSemantic();
    analyze(sem, p.program, false, true);
    return sem.errors.length === 0;
};

describe('a catch parameter and the catch body', () => {
    it('rejects a function declaration that redeclares the parameter', () => {
        expect(check('try {} catch (x) { function x(){} }')).toBe(false);
    });

    it('still rejects the lexical forms it already caught', () => {
        for (const src of [
            'try {} catch (x) { let x; }',
            'try {} catch (e) { const e = 1; }',
            'try {} catch (e) { class e {} }',
        ])
            expect(check(src), src).toBe(false);
    });

    it('leaves Annex B and the nested cases alone', () => {
        for (const src of [
            'try {} catch (x) { var x; }', // Annex B.3.4 — a `var` may redeclare a SIMPLE catch param
            'try {} catch (x) { { let x; } }', // a nested block is a different scope
            'try {} catch (x) { { function x(){} } }', // ditto
            'try {} catch (x) { function g(){ var x; } }', // a nested function has its own var scope
            'try {} catch (x) { function y(){} }', // a different name
        ])
            expect(check(src), src).toBe(true);
    });

    it('does not disturb function declarations elsewhere', () => {
        for (const src of ['{ function a(){} }', 'function h(){ function a(){} var a; }', 'function f() { function g(){} }'])
            expect(check(src), src).toBe(true);
    });
});
