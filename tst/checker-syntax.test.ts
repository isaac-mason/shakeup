// The checker layer: early errors that need the SEMANTIC MODEL, which a parser cannot decide.
//
// rolldown runs oxc's equivalent on every module and FAILS THE BUILD on it —
// `pre_process_ecma_ast.rs:70` calls `with_check_syntax_error(true)` and returns `Err` on any error.
// So these are not diagnostics we merely lack: they are programs rolldown refuses to build and
// shakeup was building silently.
//
// **A separate PASS, where oxc fuses this into the semantic build.** oxc can afford `check(kind, ctx)`
// inside `SemanticBuilder::leave_node` because both are `#[inline(always)]` and the `AstKind` match
// constant-folds away at each site — its own doc comment says so. In JS that match would be a live
// switch on every node of every `analyze` call, and `analyze` has 25 call sites, most of them mid-pass
// rebuilds that never want checking. Separate costs zero when off.
//
// Every expectation here was checked against `oxc-parser` with `showSemanticErrors: true` before it
// was written, not read off the Rust.
import { describe, expect, it } from 'vitest';
import { checkSyntax } from '../src/analysis/checker.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

const check = (src: string, isModule = false) => {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program, isModule);
    return checkSyntax(sem, program).map((e) => e.msg);
};

describe('delete of a private field — an error in EVERY mode', () => {
    it.each([
        'class C { #x; m(o){ return delete o.#x; } }',
        'class C { #x; m(o){ return delete (o?.#x); } }',
    ])('%s', (src) => {
        expect(check(src)).toEqual(["The operand of a 'delete' operator cannot be a private identifier."]);
    });

    it('deleting an ordinary member stays legal', () => {
        expect(check('delete o.x;')).toEqual([]);
        expect(check('"use strict"; delete o.x;')).toEqual([]);
    });
});

describe('delete of a bare binding — strict only', () => {
    // THE reason this cannot live in the parser: the same expression is legal or not depending on a
    // directive that may be three scopes up, which the parser never accumulates.
    it('errors in strict code', () => {
        expect(check('"use strict"; var x; delete x;')).toEqual(['Delete of an unqualified identifier in strict mode.']);
    });

    it('is legal in sloppy code', () => {
        expect(check('var x; delete x;')).toEqual([]);
    });
});

describe('legacy octal and leading-zero decimals — strict only, and two different messages', () => {
    it('`010` is a legacy octal', () => {
        expect(check('"use strict"; var x = 010;')).toEqual([
            "'0'-prefixed octal literals and octal escape sequences are deprecated",
        ]);
    });

    it('`08` is a decimal that merely starts with zero', () => {
        expect(check('"use strict"; var x = 08;')).toEqual(['Decimals with leading zeros are not allowed in strict mode']);
    });

    it.each(['0o10', '0x1f', '0b11', '0', '0.5', '0n'])('`%s` is not either', (lit) => {
        expect(check(`"use strict"; var x = ${lit};`)).toEqual([]);
    });

    it('and both are legal in sloppy code', () => {
        expect(check('var x = 010, y = 08;')).toEqual([]);
    });
});

describe('strictness reaches the rule through the SCOPE, not the file', () => {
    // Each of these is the same literal; only the enclosing scope differs. This is what P1's scope
    // tree bought, and the reason the checker needs it.
    it('a module is strict throughout', () => {
        expect(check('function f(){ return 010; }', true)).toHaveLength(1);
    });

    it('a `"use strict"` inside one function reaches its nested blocks', () => {
        expect(check('function f(){ "use strict"; { { return 010; } } }')).toHaveLength(1);
    });

    it('but not its sibling', () => {
        expect(check('function a(){ "use strict"; } function b(){ return 010; }')).toEqual([]);
    });

    it('a class body is strict even in a sloppy script', () => {
        expect(check('class C { m(){ return 010; } }')).toHaveLength(1);
    });

    it('a sloppy function stays sloppy', () => {
        expect(check('function f(){ return 010; }')).toEqual([]);
    });
});

describe('the walk itself', () => {
    it('is iterative — a deeply nested program does not exhaust the stack', () => {
        const deep = `"use strict"; ${'{'.repeat(400)} var x = 010; ${'}'.repeat(400)}`;
        expect(check(deep)).toHaveLength(1);
    });

    it('finds every occurrence, not just the first', () => {
        expect(check('"use strict"; var a = 010, b = 011, c = 012;')).toHaveLength(3);
    });
});
