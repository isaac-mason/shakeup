// A LexicalDeclaration is not a Statement, so `if (x) const y = 1;` has no parse: the `if` body is a
// Statement position and only a Statement fits. Same for `class`, `using` and `await using`. `var` is
// a Statement, so it stays legal, and a block makes any of them legal again.
//
// oxc raises this from two places with two different messages, and the split is kept here:
//   · `js/statement.rs:294` + `js/declaration.rs:65` — `lexical_declaration_single_statement`, for
//     `const` / `using` / `await using`.
//   · `js/class.rs:26` — `class_declaration`, "Invalid class declaration".
//
// TWO deliberate non-cases:
//   · `let` is already rejected, by a different route. It is contextual, so `if (x) let y = 1;`
//     parses `let` as an identifier expression and then fails for want of a semicolon — which is
//     exactly what oxc reports too ("Expected a semicolon..."). Both reject; the message differs
//     because the recovery differs, and chasing that would mean changing how `let` disambiguates.
//   · `if (x) function f(){}` is VALID. Annex B allows a function declaration in an `if` body in
//     sloppy code, so oxc ACCEPTS it in the parser and defers the strict-mode case to
//     `oxc_semantic`'s `check_function_declaration`. That is checker territory (ROADMAP §2b), not
//     this rule — putting it here would be the right rule in the wrong phase.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('a lexical declaration needs a block', () => {
    it.each([
        'if (x) const y = 1;',
        'if (x) {} else const y = 1;',
        'while (x) const y = 1;',
        'do const y = 1; while (0);',
        'for (;;) const y = 1;',
        'for (a in b) const y = 1;',
        'for (a of b) const y = 1;',
        'label: const y = 1;',
        'if (x) using y = z;',
    ])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('if (x) const y = 1;')).toBe('Lexical declaration cannot appear in a single-statement context');
        expect(msg('if (x) using y = z;')).toBe('Lexical declaration cannot appear in a single-statement context');
    });

    it('covers `await using`, which test262 reaches through a do-while', () => {
        expect(msg('async function f() { do await using x = 1; while (false) }')).toBe(
            'Lexical declaration cannot appear in a single-statement context',
        );
    });
});

describe('a class declaration gets its own diagnostic, as in oxc', () => {
    it.each(['if (x) class C {}', 'while (x) class C {}', 'do class C {} while (0);', 'label: class C {}'])('%s', rejects);

    it('reports oxc’s message', () => {
        expect(msg('if (x) class C {}')).toBe('Invalid class declaration');
    });
});

describe('what stays legal', () => {
    // `single` reaches every statement-body parent, so a wrong guard would reject ordinary code in
    // bulk. The declaration positions that must keep working are pinned here rather than left to
    // `pnpm parsercorpus` to discover.
    it.each([
        'class C {}',
        'const a = 1;',
        'using r = res();',
        'if (x) var y = 1;',
        'if (x) { const a = 1; }',
        'if (x) { class C {} }',
        'if (x) function f(){}',
        'label: function f(){}',
        'for (const a of b) {}',
        'for (const a in b) {}',
        'for (let i = 0; i < 1; i++) {}',
        'switch (x) { case 1: const a = 1; }',
        'try { const a = 1; } catch { class C {} }',
        'while (x) { using r = res(); }',
        'do { const a = 1; } while (0);',
        '{ using r = res(); }',
    ])('%s', (src) => {
        expect(errs(src), src).toEqual([]);
    });

    it('the module forms are untouched', () => {
        for (const src of ['export class C {}', 'export default class C {}', 'export default class {}', 'export const a = 1;']) {
            expect(parse(src, { ts: false, jsx: false }).errors, src).toEqual([]);
        }
    });

    it('the TS forms are untouched', () => {
        for (const src of ['declare class C {}', 'namespace N { const a = 1; class C {} }', 'const enum E { A }']) {
            expect(parse(src, { ts: true, jsx: false }).errors, src).toEqual([]);
        }
    });
});
