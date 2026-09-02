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
    it.each(['class C { #x; m(o){ return delete o.#x; } }', 'class C { #x; m(o){ return delete (o?.#x); } }'])('%s', (src) => {
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

describe('strict-mode reserved words', () => {
    // Ordinary identifiers outside strict code, which is why this cannot be a lexer keyword table.
    it.each(['yield', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public'])(
        '`%s` is reserved in strict code',
        (kw) => {
            expect(check(`"use strict"; var ${kw};`)).toEqual([`The keyword '${kw}' is reserved`]);
            expect(check(`var ${kw};`)).toEqual([]);
        },
    );

    it('applies to references and labels too, not just bindings', () => {
        expect(check('"use strict"; static;')).toEqual(["The keyword 'static' is reserved"]);
    });
});

describe('eval and arguments', () => {
    it.each(['eval', 'arguments'])('cannot be assigned in strict code: %s', (name) => {
        expect(check(`"use strict"; ${name} = 1;`)).toEqual([`Cannot assign to '${name}' in strict mode`]);
        expect(check(`${name} = 1;`)).toEqual([]);
    });

    it('cannot be BOUND in strict code either — oxc reuses the same message', () => {
        expect(check('"use strict"; var eval;')).toEqual(["Cannot assign to 'eval' in strict mode"]);
    });

    it('an update expression counts as an assignment', () => {
        expect(check('"use strict"; eval++;')).toEqual(["Cannot assign to 'eval' in strict mode"]);
    });
});

describe('a `use strict` directive needs a simple parameter list', () => {
    // The parameters would have to be evaluated under a strictness the directive only establishes
    // afterwards. A default keeps a `BindingIdentifier` pattern but carries an `init`, so the pattern
    // type alone does not settle it — that distinction was a real bug in the first cut.
    it.each(['a = 1', '[a]', '{a}', '...a', 'a, b = 1'])('non-simple: (%s)', (params) => {
        expect(check(`function f(${params}) { "use strict"; }`)).toEqual([
            "Illegal 'use strict' directive in function with non-simple parameter list",
        ]);
    });

    it.each(['a', 'a, b', ''])('simple: (%s)', (params) => {
        expect(check(`function f(${params}) { "use strict"; }`)).toEqual([]);
    });

    it('applies to arrows as well as functions', () => {
        expect(check('(a = 1) => { "use strict"; };')).toHaveLength(1);
    });

    it('and only when the directive is actually there', () => {
        expect(check('function f(a = 1) { return 1; }')).toEqual([]);
    });
});

describe('redeclaration', () => {
    // The pair matrix was taken from oxc by RUNNING it, not from the spec, and it collapses to one
    // rule: an error iff either side is LEXICAL (`let`, `const`, `class`, `import`). `var`, a
    // function, a parameter and a catch binding may all collide with each other freely.
    const DECL: Record<string, string> = {
        var: 'var x;',
        let: 'let x;',
        const: 'const x = 1;',
        fn: 'function x(){}',
        cls: 'class x {}',
    };
    const LEXICAL = new Set(['let', 'const', 'cls']);

    for (const a of Object.keys(DECL)) {
        for (const b of Object.keys(DECL)) {
            const shouldError = LEXICAL.has(a) || LEXICAL.has(b);
            it(`${a} + ${b} ${shouldError ? 'collides' : 'is fine'}`, () => {
                const got = check(`${DECL[a]} ${DECL[b]}`);
                expect(got).toEqual(shouldError ? ['Identifier `x` has already been declared'] : []);
            });
        }
    }

    it('a nested scope shadows rather than collides', () => {
        expect(check('let x; { let x; }')).toEqual([]);
    });

    it('duplicate parameters are legal sloppy and an error in strict', () => {
        expect(check('function f(a,a){}')).toEqual([]);
        expect(check('"use strict"; function f(a,a){}')).toEqual(['Identifier `a` has already been declared']);
    });

    it('a parameter collides with a lexical in the body, but not a var', () => {
        expect(check('function f(a){ let a; }')).toEqual(['Identifier `a` has already been declared']);
        expect(check('function f(a){ var a; }')).toEqual([]);
    });

    it('a catch parameter collides with the block’s own lexicals only', () => {
        expect(check('try{}catch(e){ let e; }')).toEqual(['Identifier `e` has already been declared']);
        expect(check('try{}catch([e]){ let e; }')).toEqual(['Identifier `e` has already been declared']);
        expect(check('try{}catch(e){ var e; }')).toEqual([]);
        expect(check('try{}catch(e){ { let e; } }')).toEqual([]);
    });

    // KNOWN GAP, recorded so it is not mistaken for a passing case: oxc reports this and we do not.
    // A function declaration hoists out of the catch block AND `declareInScope` has already entered
    // the function's own scope by the time the binding is made, so neither scope identifies the catch
    // body. Missing it is the SAFE direction — an error not reported, never valid code rejected.
    it('but a function declaration in a catch block is a known gap', () => {
        expect(check('try{}catch(e){ function e(){} }')).toEqual([]);
    });
});

describe('break, continue and labels', () => {
    // oxc walks UP from the jump (`ctx.ancestry()`); this carries the same information DOWN, because
    // the walk is already top-down and a parent map would cost an entry per node. Same answers,
    // verified case by case against `oxc-parser`.
    it('a bare break needs a loop or a switch', () => {
        expect(check('break;')).toEqual(['Illegal break statement']);
        expect(check('while(1){ break; }')).toEqual([]);
        expect(check('switch(x){case 1: break;}')).toEqual([]);
    });

    it('a bare continue needs a LOOP — a switch is not enough', () => {
        expect(check('continue;')).toEqual(['Illegal continue statement: no surrounding iteration statement']);
        expect(check('while(1){ continue; }')).toEqual([]);
        expect(check('switch(x){case 1: continue;}')).toEqual(['Illegal continue statement: no surrounding iteration statement']);
    });

    it('a jump may not cross a function boundary', () => {
        expect(check('while(1){ (function(){ break; }); }')).toEqual(['Illegal break statement']);
        expect(check('class C { static { break; } }')).toEqual(['Illegal break statement']);
    });

    // A DELIBERATE DIVERGENCE, and the direction is "stricter than oxc". oxc's ancestry match lists
    // `AstKind::Function` and `AstKind::StaticBlock` but NOT `ArrowFunctionExpression`, so it accepts
    // this; node rejects it and so does the spec — an arrow is a function boundary like any other.
    // Same call as `static accessor prototype`: the language outranks oxc when they disagree.
    // `pnpm checkerdiff` stays at 0 because no shipped code contains a syntax error.
    it('including an ARROW, where oxc has a gap', () => {
        expect(check('while(1){ (()=>{ break; }); }')).toEqual(['Illegal break statement']);
        expect(() => new Function('while(1){ (()=>{ break; }); }')).toThrow();
    });

    it('a label lets break reach any statement, continue only a loop', () => {
        expect(check('a: while(1){ break a; }')).toEqual([]);
        expect(check('a: while(1){ continue a; }')).toEqual([]);
        expect(check('a: { break a; }')).toEqual([]);
        expect(check('a: { continue a; }')).toEqual([
            'A `continue` statement can only jump to a label of an enclosing `for`, `while` or `do while` statement.',
        ]);
    });

    it('and a label must exist, in this function', () => {
        expect(check('a: while(1){ break b; }')).toEqual(['Use of undefined label']);
        expect(check('a: while(1){ (function(){ b: while(1){ break b; } }); }')).toEqual([]);
    });

    it('a label may not be declared twice', () => {
        expect(check('a: a: while(1){}')).toEqual(['Label `a` has already been declared']);
        expect(check('a: while(1){ b: while(1){} }')).toEqual([]);
    });

    it('a label naming a loop through other labels is still continuable', () => {
        expect(check('a: b: while(1){ continue a; }')).toEqual([]);
    });
});
