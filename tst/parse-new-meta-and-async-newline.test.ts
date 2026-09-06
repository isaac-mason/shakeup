import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// Two token-sequence rules from `pnpm misslayers`' PARSER bucket. Both confirmed against BOTH
// oracles before writing — `oxc-parser` and node agree on every case here.
const accepts = (src: string): boolean =>
    parseWithDiagnostics(src, { ts: false, jsx: false, kind: 'unambiguous' }).errors.length === 0;

describe('`new.` admits exactly one meta property', () => {
    // The name after `new.` was consumed without being looked at, so `new.foo` parsed as `new.target`
    // and so did `new.target`.
    it('rejects any name but `target`', () => {
        expect(accepts('function f() { new.foo; }')).toBe(false);
    });

    it('rejects an ESCAPED spelling of `target`', () => {
        // The escape test is needed here even though shakeup's lexer leaves an escaped identifier as
        // `T_IDENT` — `target` is not a keyword, so the name arrives as an ordinary identifier
        // either way and only the flag tells the two spellings apart.
        for (const src of ['function f() { new.t\\u0061rget; }', 'function f() { new.tar\\u0067et; }'])
            expect(accepts(src), src).toBe(false);
    });

    it('leaves the legal forms alone', () => {
        for (const src of [
            'function f() { new.target; }',
            'function f() { new.target.value; }',
            'function f() { new.target?.x; }',
            'class C { constructor() { new.target; } }',
            'function f() { new Foo(); }',
            'function f() { new (Foo)(); }',
        ])
            expect(accepts(src), src).toBe(true);
    });
});

describe('`async` as a method modifier takes no line terminator', () => {
    // The grammar is `async [no LineTerminator here] PropertyName`. With a newline, `async` was
    // never a modifier — it is an ordinary property name, and what follows is then unexpected.
    it('rejects a newline between `async` and an object method name', () => {
        expect(accepts('({\n  async\n  foo() { }\n})')).toBe(false);
    });

    it('still accepts the same shape in a CLASS body, where `async` becomes a field', () => {
        // Both oracles accept this: ASI ends the `async` field declaration, and `foo(){}` is then an
        // ordinary method. The rule is about not consuming `async` as a modifier, not about erroring.
        expect(accepts('class C {\n  async\n  foo() { }\n}')).toBe(true);
    });

    it('leaves every other `async` position alone', () => {
        for (const src of [
            '({ async foo() { } })',
            'class C { async foo() { } }',
            '({ async })',
            '({ async, b: 1 })',
            '({ async: 1 })',
            'class C { async }',
            'class C { async; foo(){} }',
            '({ async *g() {} })',
            'class C { async *g() {} }',
            '({ async ["x"]() {} })',
            '({\n  get\n  foo() { }\n})', // `get` has no such restriction
        ])
            expect(accepts(src), src).toBe(true);
    });
});
