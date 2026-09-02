// `let` is a contextual keyword, and WHERE it appears decides whether it declares. A
// LexicalDeclaration is not a Statement, so a single-statement position cannot hold one — which
// makes `if (false) let\n{}` an identifier plus ASI, not a destructuring declaration.
//
// `parseStatement` took no statement-position parameter at all. It now does, and every call site
// declares its position. oxc threads the same thing as `StatementContext` (`context.rs:176`).
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const agreesWithNode = (src: string): void => {
    let node = true;
    try {
        new Function(src);
    } catch {
        node = false;
    }
    const ok = parse(src, { ts: false, jsx: false }).errors.length === 0;
    expect(ok, `${src} — node says ${node ? 'valid' : 'invalid'}`).toBe(node);
};

describe('`let` in a single-statement position is an identifier', () => {
    it.each(['if (false) let\n{}', 'while (0) let', 'foo: let', 'do let; while (0)', 'for (;;) let'])('%s', agreesWithNode);

    it('and a declaration there is now correctly REJECTED', () => {
        // Previously accepted — a false-accept the harmful counter never flagged.
        expect(() => new Function('if (1) let x = 1;')).toThrow();
        expect(parse('if (1) let x = 1;', { ts: false, jsx: false }).errors).not.toEqual([]);
    });
});

describe('`let` in a for head', () => {
    // `for (let;;)` and `for (let in {})` are the identifier; only the next token separates them
    // from a declaration. oxc `Kind::is_after_let` (`lexer/kind.rs:298`).
    it.each([
        'for (let;;) break;',
        'for (let in {}) ;',
        'for (let x = 0;;) break;',
        'for (let x of xs) {}',
        'for (let [a] of xs) {}',
        'for (let {a} of xs) {}',
        'for (let of of xs) {}',
    ])('%s', agreesWithNode);
});

describe('`let` as an ordinary expression', () => {
    it.each(['let;', 'let.a = 1;', 'let = 1;', 'let instanceof x;', 'let + 1;', 'let()[a] = 1;'])('%s', agreesWithNode);
});

describe('`let` still declares where it may', () => {
    it.each(['let x = 1;', 'let { a } = o;', 'let [a] = o;', 'let a, b;', '{ let x = 1; }'])('%s', agreesWithNode);
});
