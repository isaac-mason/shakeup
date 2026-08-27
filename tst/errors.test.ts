import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser';
import { formatError, ParseErrorCode } from '../src/parser/errors.ts';

const first = (src: string, ts = true, jsx = false) => parse(src, { ts, jsx }).errors[0];

describe('errors.ts', () => {
    it('every code has a template', () => {
        for (const [name, code] of Object.entries(ParseErrorCode)) {
            const msg = formatError(code, []);
            expect(msg, `missing template for ${name}`).toBeTruthy();
        }
    });

    it('substitutes %0', () => {
        expect(formatError(ParseErrorCode.Expected, ["';'"])).toBe("expected ';'");
        expect(formatError(ParseErrorCode.ExpectedInJSX, ["'}'"])).toBe("expected '}' in JSX");
        expect(formatError(ParseErrorCode.UnexpectedChar, ['@'])).toBe("unexpected character '@'");
    });

    it('parse sites carry the right code + message (unchanged wording)', () => {
        const oc = first('new a?.b()');
        expect(oc.code).toBe(ParseErrorCode.NewOptionalChain);
        expect(oc.msg).toBe('optional chain is not allowed in a new expression');

        const tag = first('a?.b`x`');
        expect(tag.code).toBe(ParseErrorCode.TaggedOptionalChain);
        expect(tag.msg).toBe('tagged template cannot be used with an optional chain');

        // expectP funnels the "expected 'X'" family through one parameterized code.
        const paren = first('foo(1');
        expect(paren.code).toBe(ParseErrorCode.Expected);
        expect(paren.msg).toBe("expected ')'");
    });

    it('unexpected-token messages name the offending token', () => {
        const e = first('1 + @', false);
        expect(e.code).toBe(ParseErrorCode.UnexpectedInExpression);
        expect(e.msg).toBe("unexpected token '@' in expression");
    });
});

// Found by `pnpm parserdiff` — oxc rejects an unterminated literal in every module goal, and shakeup
// accepted all three SILENTLY. `export const x = 'abc` parsed with `errors: []` and emitted
// `const x = 'abc;`, itself invalid JavaScript: a build that reported success produced a bundle that
// cannot load. An unterminated string also swallowed the rest of the file, since nothing stopped the
// scan at a line terminator.
describe('unterminated literals', () => {
    const msgs = (src: string) =>
        parse(src, { ts: false, jsx: false })
            .errors.map((e) => e.msg)
            .join(' | ');

    it('reports an unterminated string', () => {
        expect(msgs("var s = 'abc")).toMatch(/unterminated string/);
    });

    it('reports a string containing a raw line terminator', () => {
        // Only an ESCAPED line terminator may span lines; a raw one ends the literal.
        expect(msgs("var s = 'abc\ndef';")).toMatch(/unterminated string/);
    });

    it('reports a lone opening quote at end of input', () => {
        // The `closed` flag exists for exactly this: inspecting the previous character instead would
        // read the OPENING quote back and conclude the literal was terminated.
        expect(msgs("var s = '")).toMatch(/unterminated string/);
    });

    it('reports an unterminated template', () => {
        expect(msgs('var s = `abc')).toMatch(/unterminated template/);
    });

    it('reports an unterminated block comment', () => {
        expect(msgs('var s = 1; /* abc')).toMatch(/unterminated block comment/);
    });

    it.each([
        ['a plain string', "var s = 'abc';"],
        ['a string ending at EOF', "var s = 'abc'"],
        ['an escaped line continuation', "var s = 'a\\\nb';"],
        ['an escaped quote', "var s = 'a\\'b';"],
        ['a double-quoted string', 'var s = "abc";'],
        ['a template with a substitution', 'var s = `a${1}b`;'],
        ['a nested template', 'var s = `a${`b${c}d`}e`;'],
        ['a closed block comment', 'var s = 1; /* ok */'],
        ['a line comment at EOF', 'var s = 1; // ok'],
    ])('does not misfire on %s', (_label, src) => {
        expect(msgs(src)).not.toMatch(/unterminated/);
    });
});

// Found by `pnpm parsercorpus` — parsing every JS file in webpack/rspack/vite with shakeup and with
// the real oxc parser. 38 real files failed on this alone.
//
// The grammar's restriction is `async [no LineTerminator here] ArrowFunction`: it sits BETWEEN
// `async` and its parameters. shakeup tested `F_NL` on the `async` token itself, which asks whether
// there was a newline BEFORE `async` — always legal. So any multiline call taking an async arrow
// argument failed with `expected ')'`, which is about as common a shape as JavaScript has.
describe('async arrows after a line break', () => {
    const ok = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each([
        ['a newline before the argument', 'f("P",\n async (d) => { return 1; });'],
        ['every argument on its own line', 'f(\n "P",\n async (d) => {\n  return 1;\n }\n);'],
        ['a bare-parameter async arrow after a newline', 'f(\n async d => d);'],
        ['a zero-parameter async arrow after a newline', 'f(\n async () => 1);'],
        ['assignment across a line break', 'const g =\n async (d) => d;'],
        ['inside an array literal', '[\n async (d) => d,\n];'],
    ])('accepts %s', (_label, src) => {
        expect(ok(src)).toEqual([]);
    });

    it.each([
        ['a single-line call', 'f("P", async (d) => 1);'],
        ['`async` as a plain identifier', 'var async = 1; async;'],
        ['`async` then a newline then a call', 'async\n(d);'],
        ['an async function declaration', 'async function f() {}'],
        ['`async` then a newline then `function`', 'async\nfunction f() {}'],
        ['an async method', 'const o = { async m() {} };'],
    ])('does not regress %s', (_label, src) => {
        expect(ok(src)).toEqual([]);
    });
});

// A parser that hangs or exhausts memory on bad input is worse than one that rejects it: a bundler
// must never be killed by a file it was asked to read.
//
// `llm/repro/parser-oom.js` — 347 bytes of Flow-typed source, parsed as plain JavaScript — exhausted
// a 4GB heap and killed the process with `Ineffective mark-compacts near heap limit`. Found by
// running `pnpm parsercorpus` over `node_modules`, which died partway through.
//
// Cause: every `while (!isP(state, <closer>) && tok !== T_EOF)` loop assumed its body consumed a
// token. `expectP` and `parseNameAsIdent` REPORT without consuming, so a token that is neither the
// closer, nor EOF, nor anything the body handles left the state identical — and the loop spun,
// allocating one node per turn. `parseBindingTarget`'s object-pattern loop was the one that fired;
// eight loops shared the hazard and now call `noProgress`.
//
// These assertions are about TERMINATION, not error text. `pnpm parserfuzz` covers the general case
// by mutating real sources; these pin the specific shapes.
describe('the parser always terminates on invalid input', () => {
    const parses = (src: string, ts = false) => {
        const r = parse(src, { ts, jsx: false });
        return Array.isArray(r.errors);
    };

    it('the 347-byte input that exhausted a 4GB heap', () => {
        const src = readFileSync(new URL('../llm/repro/parser-oom.js', import.meta.url), 'utf8');
        expect(parses(src)).toBe(true);
    });

    it.each([
        ['an object pattern meeting a token it cannot start a property with', 'function f({ a, ) ) {}'],
        ['an array pattern likewise', 'function f([ a, ) ) {}'],
        ['an array literal with a stray closer', 'x = [1, ) ];'],
        ['import specifiers with a stray token', "import { a, ) } from 'm';"],
        ['export specifiers with a stray token', 'export { a, ) };'],
        ['a switch body that is not a case', 'switch (x) { ) }'],
        ['a nested block of junk', 'function f() { ) ) ) }'],
        ['unbalanced closers at top level', ') ) ) ) )'],
        [
            'a mid-function fragment',
            '  a: B,\n): C<D, E<F, G>> {\n  let h: I<J> = new K(\n    () => new Map(),\n  );\n  m.n({\n    o(p, q) {\n',
        ],
    ])('terminates on %s', (_label, src) => {
        expect(parses(src)).toBe(true);
    });

    it.each([
        ['an enum with a stray token', 'enum E { A, ) }'],
        ['a tuple type with a stray token', 'let x: [A, ) ];'],
    ])('terminates on %s (TypeScript)', (_label, src) => {
        expect(parses(src, true)).toBe(true);
    });

    it('still parses the valid forms of every guarded construct', () => {
        // The guards must not fire on well-formed input.
        for (const [src, ts] of [
            ['function f({ a, b: { c } = {}, ...r }) { return [a, c, r] }', false],
            ['function f([a, , b, ...r]) { return [a, b, r] }', false],
            ['x = [1, , 3, ...y];', false],
            ["import { a, b as c } from 'm';", false],
            ['export { a, b as c };\nvar a = 1, b = 2;', false],
            ['switch (x) { case 1: y(); break; default: z(); }', false],
            ['enum E { A = 1, B, C = 3 }', true],
            ['let x: [A, B?, ...C[]];', true],
        ] as const) {
            expect(parse(src, { ts, jsx: false }).errors, src).toEqual([]);
        }
    });
});

// The parser reports ONE error per file and stops — oxc's `set_fatal_error` model
// (`oxc_parser/src/error_handler.rs:84-89`), which records the diagnostic and calls
// `lexer.advance_to_end()`.
//
// Measured against the references before adopting it: meriyah THROWS on the first error, esbuild
// reports exactly 1, oxc reports exactly 1 — for two INDEPENDENT errors as well as for one. shakeup
// reporting up to 9 cascading errors was the outlier.
//
// Nothing is lost by stopping: both consumers discard the AST when any error is present
// (`bundle.ts` returns early on `graph.errors.length > 0`; `transform.ts` returns `emptyResult`).
// And it makes termination STRUCTURAL — jumping to EOF exits every recovery loop in the parser at
// its next test, rather than each loop having to be proved to make progress.
describe('one error per file, then stop', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

    it.each([
        ['a stray token in an object pattern', 'function f({ a, ) ) {}'],
        ['a stray token in an array literal', 'x = [1, ) ];'],
        ['unbalanced closers', ') ) ) ) )'],
        ['two independent errors', 'let 1x = 1;\nlet 2y = 2;'],
        ['an error followed by valid code', 'function f({ a, ) ) {}\nconst ok = 1;'],
    ])('reports exactly one for %s', (_label, src) => {
        expect(errs(src)).toHaveLength(1);
    });

    it('reports the FIRST error, not a later one', () => {
        const e = errs("var s = 'abc\nlet 1x = 2;");
        expect(e).toHaveLength(1);
        expect(e[0].msg).toMatch(/unterminated string/);
    });

    it('valid code is unaffected', () => {
        expect(errs('const a = 1;\nfunction f() { return a }\nexport { f };')).toEqual([]);
    });

    it('a failed speculative probe does not latch the parse', () => {
        // Speculation raises errors on purpose and rewinds them. If `fatal` were not rewound with
        // the rest of the state, the first probe to fail would kill the whole file. `async (a) => a`
        // and TS generics both take that path.
        expect(errs('const g = async (a) => a;\nconst h = 1;')).toEqual([]);
        expect(parse('let x: Array<number> = [];\nlet y = 2;', { ts: true, jsx: false }).errors).toEqual([]);
        expect(errs('f(\n  async (d) => d,\n);')).toEqual([]);
    });
});
