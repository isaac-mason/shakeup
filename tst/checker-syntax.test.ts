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
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { DEFS, N, type Node, walkChildren } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

const check = (src: string, isModule = false) => {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program, isModule, true);
    return sem.errors.map((e) => e.msg);
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

describe('Annex B decides HOW FAR the block-function check reaches', () => {
    // Not obvious, and each line below cost a round of false rejections in test262 before it was right:
    // a `var` is checked against every scope it passes through, a block function only against the one
    // it was written in, and the `if` position is exempt outright.
    it.each([
        '{ let f; function f(){} }',
        '{ let f; async function f(){} }',
        '{ const f = 1; function f(){} }',
        '{ class f {} function f(){} }',
        '{ function f(){} let f; }',
        '{ function f(){} class f {} }',
        '{ async function f(){} class f {} }',
        'switch(0){ case 1: function f(){} case 2: class f {} }',
    ])('rejects %s — the collision is in the function OWN block', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it.each([
        // B.3.3: the alias merely hoists PAST the lexical binding, so the early error is skipped.
        // Walking the full scope chain for functions rejected 80 valid test262 programs.
        '{ let f = 123; { function f(){} } }',
        '{ let f; { { function f(){} } } }',
        'let f = 1; { function f(){} }',
        // B.3.4: the `if` position is exempt outright. Missing this rejected 20 more.
        '{ let f = 123; if (true) function f(){} }',
        'let f; if (1) function f(){}',
        '{ let f = 1; if (1) function f(){} else function _f(){} }',
    ])('accepts %s — Annex B skips the early error', (src) => {
        expect(check(src)).toEqual([]);
    });

    it('a `var` gets no such reprieve — it IS checked against every scope it passes', () => {
        expect(check('{ let x; { var x; } }')).toEqual(['Identifier `x` has already been declared']);
    });
});

describe("Annex B's block-function alias is JavaScript-only", () => {
    // oxc gates the hoist on `!source_type.is_typescript()` (`binder.rs:179`), so in a `.ts` file a
    // block function stays block-scoped and never meets a hoisted `var`. Confirmed with `tsc`, which
    // accepts BOTH orders — we were rejecting one of them, a false rejection in a TS-capable bundler.
    const checkTs = (src: string) => {
        const { program } = parse(src, { ts: true, jsx: false });
        const sem = createSemantic();
        analyze(sem, program, false, true, true);
        return sem.errors.map((e) => e.msg);
    };

    it.each(['{ function f(){} var f; }', '{ var f; function f(){} }'])('accepts %s in TypeScript', (src) => {
        expect(checkTs(src)).toEqual([]);
    });

    it.each(['{ function f(){} var f; }', '{ var f; function f(){} }'])('but rejects %s in JavaScript', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it('a lexical collision in the same block is still an error in TypeScript', () => {
        expect(checkTs('{ let f; function f(){} }')).toEqual(['Identifier `f` has already been declared']);
    });
});

describe('a redeclared function is judged against ALL its earlier declarations', () => {
    // oxc's `check_redeclared_function` (`checker/javascript.rs:740-751`) scans every previous
    // declaration for the `async`/generator one that makes the set illegal, so it can point the error
    // at it. A pairwise record cannot express this: with three declarations the offender may be two
    // back, and merged symbol flags cannot say which declaration was which.
    it.each([
        '{ async function f(){} function f(){} function f(){} }',
        '{ function* f(){} function f(){} function f(){} }',
        '{ function f(){} function f(){} async function f(){} }',
    ])('rejects %s — the culprit is not the immediately previous one', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it('three plain declarations in one block stay legal under Annex B', () => {
        expect(check('{ function f(){} function f(){} function f(){} }')).toEqual([]);
    });

    it('reports ONCE, not once per pair', () => {
        expect(check('{ async function f(){} function f(){} function f(){} }')).toHaveLength(1);
    });
});

describe('at most one constructor per class', () => {
    it.each(['class C { constructor(){} constructor(){} }', 'const K = class { constructor(){} constructor(){} };'])(
        'rejects %s',
        (src) => {
            expect(check(src)).toEqual(['Multiple constructor implementations are not allowed.']);
        },
    );

    it.each([
        'class C { constructor(){} }',
        // A STATIC `constructor` is an ordinary static method, not the class constructor.
        'class C { constructor(){} static constructor(){} }',
        'class C { m(){} m(){} }',
        'class C { get x(){} set x(v){} }',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe('a duplicate `__proto__` in an object literal', () => {
    // Only a plain `__proto__: value` pair sets the prototype. Every other spelling defines an
    // ordinary property, so comparing key NAMES alone would over-report all four accepted forms.
    it.each(['({ __proto__: 1, __proto__: 2 });', '({ "__proto__": 1, __proto__: 2 });'])('rejects %s', (src) => {
        expect(check(src)).toEqual(['Identifier `__proto__` has already been declared']);
    });

    it.each([
        '({ __proto__: 1, ["__proto__"]: 2 });',
        '({ __proto__: 1, __proto__ });',
        '({ __proto__(){}, __proto__(){} });',
        '({ get __proto__(){}, get __proto__(){} });',
        '({ __proto__: 1 });',
        '({ a: 1, a: 2 });',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe('a `var` and a block FUNCTION that hoist past each other', () => {
    // Every expectation here is NODE's. oxc rejects three of the accepted shapes below — sibling
    // blocks and a var-scoped `function f(){}` with `var f` in a nested block — which node accepts, so
    // this rule is DELIBERATELY less strict than oxc. Both bindings land in the same hoist target
    // either way; `at` is what says where each was written, and that decides whether the paths cross.
    it.each([
        '{ function f(){} { var f; } }',
        '{ function f(){} { { var f; } } }',
        'function g(){ { function f(){} { var f; } } }',
        '{ { var f; } function f() {} }',
        '{ { var f; } async function f() {} }',
        '{ { var f; } function* f() {} }',
        '{ { { var f; } } async function f(){} }',
        '{ async function f(){} { var f; } }',
    ])('rejects %s — the paths cross', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it.each([
        // SIBLING blocks never cross, whichever order they come in.
        '{ function f(){} } { var f; }',
        '{ { var f; } } { async function f(){} }',
        'function g(){ { function f(){} } { var f; } }',
        'function g(){ { { function f(){} } { var f; } } }',
        // A function at the top of a function body is VAR-scoped there, not lexical.
        'function g(){ function f(){} { var f; } }',
        'function f(){} var f;',
        'function g(){ var f; function f(){} }',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe('a `var` may not hoist THROUGH a scope that lexically binds the same name', () => {
    // The `var` lands in the hoist target while the `let` stays in the block, so the two never meet on
    // one binding and the ordinary redeclaration path cannot see them.
    it.each([
        '{ let x; var x; }',
        '{ const x = 1; var x; }',
        '{ class x {} var x; }',
        'class C { static { let x; var x; } }',
        'class C { static { let x; { var x; } } }',
        'switch(0){ case 1: let x; case 2: var x; }',
        'for (let x of []) { var x; }',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(['Identifier `x` has already been declared']);
    });

    it.each([
        // Nothing hoists THROUGH the `let` in any of these.
        'var x; { let x; }',
        '{ let x; } var x;',
        'function f(){ { let x; } { var x; } }',
        '{ let x; function g(){ var x; } }',
        '{ let x; var y; }',
        'try {} catch (e) { var e; }',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        '{ var x; let x; }',
        '{ var x; const x = 1; }',
        '{ var x; class x {} }',
        'switch(0){ case 1: var x; case 2: let x; }',
    ])('and the mirror form too: %s', (src) => {
        // Closed by `SymbolRec.at`, added for the block-function rule. The `var` hoists away to a
        // different binding, so only the scope it was WRITTEN in separates this from the legal
        // `var x; { let x; }`.
        expect(check(src)).toEqual(['Identifier `x` has already been declared']);
    });

    it.each(['function f(){ { var x; } let x; }', 'class x {} var x;', 'var x; class x {}'])(
        'and the plain same-scope collisions these resemble: %s',
        (src) => {
            // Not the new rule — the `var` and the lexical binding already share a scope here. Listed
            // so the boundary is explicit: I first wrote these as ACCEPTED and oxc disagreed.
            expect(check(src)).toEqual(['Identifier `x` has already been declared']);
        },
    );

    it('but two sibling blocks are still separate', () => {
        expect(check('{ var x; } { let x; }')).toEqual([]);
    });
});

describe('`eval`/`arguments` as a DESTRUCTURING assignment target', () => {
    // The rule used to look at the top-level node only, so it caught `eval = 1` and none of these.
    it.each([
        '"use strict"; ({ eval = 0 } = {});',
        '"use strict"; [eval] = [];',
        '"use strict"; ({ a: eval } = {});',
        '"use strict"; [...eval] = [];',
        '"use strict"; ({ a: { b: eval } } = {});',
        '"use strict"; for ([eval] of []) ;',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(["Cannot assign to 'eval' in strict mode"]);
    });

    it.each(['"use strict"; ({ arguments = 0 } = {});', '"use strict"; [arguments] = [];'])('rejects %s', (src) => {
        expect(check(src)).toEqual(["Cannot assign to 'arguments' in strict mode"]);
    });

    it.each(['({ eval = 0 } = {});', '"use strict"; [a.eval] = [];', '"use strict"; ({ eval: x } = {});'])(
        'accepts %s',
        (src) => {
            expect(check(src)).toEqual([]);
        },
    );

    it('DELIBERATELY stricter than oxc: a bare `for (eval of ...)` head', () => {
        // oxc ACCEPTS this while rejecting `for ([eval] of [])`, which is inconsistent. Node rejects
        // both ("Unexpected eval or arguments in strict mode"), so the gap is oxc's. Checked against a
        // third implementation before keeping our answer, per the usual rule about fixtures.
        expect(check('"use strict"; for (eval of []) ;')).toEqual(["Cannot assign to 'eval' in strict mode"]);
    });
});

describe('`let` as a binding name in a `let` or `const` declaration', () => {
    it.each(['let let = 1;', 'let [let] = [];', 'let { let } = {};', 'for (let let in {}) {}', 'for (let let of []) {}'])(
        'rejects %s',
        (src) => {
            expect(check(src)).toEqual(['`let` cannot be declared as a variable name inside of a `let` declaration']);
        },
    );

    it('names the `const` kind in its own message', () => {
        expect(check('const let = 1;')).toEqual(['`let` cannot be declared as a variable name inside of a `const` declaration']);
    });

    it.each(['var let = 1;', 'let x = 1;', 'function let(){}'])('accepts %s in sloppy code', (src) => {
        expect(check(src)).toEqual([]);
    });

    it('in STRICT code the reserved-word rule reports instead', () => {
        expect(check('"use strict"; let let = 1;')).toEqual(["The keyword 'let' is reserved"]);
    });
});

describe('legacy octal and non-octal-decimal ESCAPES in a string', () => {
    // `\0` is the exception that makes a naive scan wrong: it is the NUL escape unless a DIGIT
    // follows. Every line was run through oxc first.
    it.each([
        '"use strict"; "\\07";',
        '"use strict"; "\\08";',
        '"use strict"; "\\1";',
        '"use strict"; "\\7";',
        '"use strict"; "\\377";',
        "'use strict'; '\\07';",
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(["'0'-prefixed octal literals and octal escape sequences are deprecated"]);
    });

    it.each(['"use strict"; "\\8";', '"use strict"; "\\9";'])('reports \\8 and \\9 differently: %s', (src) => {
        expect(check(src)).toEqual(['Invalid escape sequence']);
    });

    it.each([
        '"\\07";',
        '"use strict"; "\\0";',
        '"use strict"; "\\0a";',
        '"use strict"; "\\x41";',
        '"use strict"; "\\\\07";',
        '"use strict"; "a\\nb";',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it('a module is strict, so no directive is needed', () => {
        expect(check('"\\07";', true)).toEqual(["'0'-prefixed octal literals and octal escape sequences are deprecated"]);
    });

    it('the DIRECTIVE PROLOGUE is checked too', () => {
        // `"\07"; "use strict";` — the prologue is already strict by the time it is reached.
        expect(check('"\\07"; "use strict";')).toEqual(["'0'-prefixed octal literals and octal escape sequences are deprecated"]);
    });
});

describe('a label passes its statement position through to what it labels', () => {
    it.each([
        'do label1: function f() {} while (false)',
        'do label1: label2: function f() {} while (false)',
        'while(0) lbl: function f(){}',
        'for(;;) lbl: function f(){}',
        'for (x of o) lbl: function f(){}',
        'if (1) lbl: function f(){}',
        '"use strict"; lbl: lbl2: function f(){}',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(['Invalid function declaration']);
    });

    it.each([
        'lbl: function f(){}',
        'lbl: lbl2: function f(){}',
        'lbl: lbl2: lbl3: function f(){}',
        'lbl: { function f(){} }',
        'if (1) lbl: { function f(){} }',
    ])('accepts %s in sloppy code', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe('a declaration in single-statement position', () => {
    // Four positions, four different answers — taken from oxc one at a time. `if`/`else` and a label
    // keep Annex B's sloppy allowance; a loop body has none.
    it.each([
        'if (1) function f(){}',
        'if (1) ; else function f(){}',
        'lbl: function f(){}',
        'if (1) { function f(){} }',
        'while (0) { function f(){} }',
        'lbl: { function f(){} }',
    ])('accepts %s in sloppy code', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        '"use strict"; if (1) function f(){}',
        '"use strict"; lbl: function f(){}',
        'while (0) function f(){}',
        'for (;;) function f(){}',
        'do function f(){} while(0);',
        'for (x in o) function f(){}',
        'for (x of o) function f(){}',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(['Invalid function declaration']);
    });

    it('the position does not leak into a declaration nested in a block', () => {
        expect(check('"use strict"; if (1) { function f(){} }')).toEqual([]);
    });

    it("generators, async functions and classes are the PARSER's job, not this rule's", () => {
        // Arms for these were written here and then deleted: the parser already rejects all three with
        // oxc's exact messages, so they were unreachable.
        for (const src of ['if (1) function* f(){}', 'if (1) async function f(){}', 'if (1) class C {}']) {
            expect(parse(src, { ts: false, jsx: false }).errors.length).toBeGreaterThan(0);
        }
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
    // esbuild rejects it too (`Cannot use "break" here`), so node, rollup AND esbuild all agree — oxc is
    // alone. `pnpm checkerdiff` stays at 0 because no shipped code contains a syntax error.
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

describe('private names', () => {
    // Visible private names are the UNION of every enclosing class, collected BEFORE descending so a
    // method may reference a `#field` declared later in the same body. A class is not a function
    // boundary for this — an arrow inside a method still sees them.
    it('two distinct messages: no class at all, versus an undeclared name', () => {
        expect(check('o.#x;')).toEqual(["Private identifier '#x' is not allowed outside class bodies"]);
        expect(check('class C { m(o){ return o.#y; } }')).toEqual(["Private field '#y' must be declared in an enclosing class"]);
    });

    it.each([
        'class C { #y; m(o){ return o.#y; } }',
        'class C { m(o){ return o.#y; } #y; }',
        'class C { #m(){} n(o){ return o.#m(); } }',
        'class A { #p; m(){ class B { n(o){ return o.#p; } } } }',
        'class C { #y; m(){ return function(o){ return o.#y; }; } }',
        'class C { #y; m(){ return o => o.#y; } }',
        'class C { #x; m(o){ return o?.#x; } }',
    ])('resolves: %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it('a sibling class does not share them', () => {
        expect(check('class A { #p; } class B { m(o){ return o.#p; } }')).toEqual([
            "Private field '#p' must be declared in an enclosing class",
        ]);
    });

    it('the `#x in o` brand check is the same rule in a different position', () => {
        expect(check('class C { #x; m(o){ return #x in o; } }')).toEqual([]);
        expect(check('class C { m(o){ return #y in o; } }')).toEqual([
            "Private field '#y' must be declared in an enclosing class",
        ]);
        expect(check('#x in o;')).toEqual(["Private identifier '#x' is not allowed outside class bodies"]);
    });
});

describe('duplicate class elements', () => {
    // Private names share ONE namespace per class, unlike public members where `m(){}` and
    // `static m(){}` coexist happily.
    it('public members may repeat; private ones may not', () => {
        expect(check('class C { m(){} m(){} }')).toEqual([]);
        expect(check('class C { #m(){} #m(){} }')).toEqual(['Identifier `#m` has already been declared']);
        expect(check('class C { #x; #x(){} }')).toEqual(['Identifier `#x` has already been declared']);
    });

    it('static does NOT open a second slot for a private name', () => {
        expect(check('class C { #x; static #x; }')).toEqual(['Identifier `#x` has already been declared']);
    });

    it('a getter/setter pair is the one exemption, and only when static-ness matches', () => {
        expect(check('class C { get #x(){} set #x(v){} }')).toEqual([]);
        expect(check('class C { static get #x(){} static set #x(v){} }')).toEqual([]);
        expect(check('class C { get #x(){} static get #x(){} }')).toEqual(['Identifier `#x` has already been declared']);
    });

    // ANOTHER DELIBERATE DIVERGENCE, stricter than oxc — the third found today. A completed get/set
    // pair fills the slot, so a THIRD accessor on the same name collides. oxc accepts it; node
    // rejects it, and so does esbuild ("The symbol \"#x\" has already been declared"). rollup builds it,
    // so it is 2-2 among implementations with the RUNTIME on the strict side.
    it('a third accessor collides, where oxc has a gap', () => {
        expect(check('class C { get #x(){} set #x(v){} get #x(){} }')).toEqual(['Identifier `#x` has already been declared']);
        expect(() => new Function('class C { get #x(){} set #x(v){} get #x(){} }')).toThrow();
    });

    it('separate classes have separate namespaces', () => {
        expect(check('class C { #x; } class D { #x; }')).toEqual([]);
    });
});

describe("a named function expression's own name may be shadowed by its body", () => {
    // The spec binds it in a scope of its own, outside the function scope. We bind it inside (a
    // separate scope would change the tree the mangler reads), so the collision is recorded and then
    // excused. Found as the single remaining checker false-rejection in test262 once the harness
    // started running the checker at all.
    it.each([
        '(function n() { let n = 1; });',
        '(function n() { const n = 1; });',
        '(function n() { class n {} });',
        '(function n(n) { });',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it('a function DECLARATION gets no such excuse', () => {
        expect(check('function n() {} let n;')).toEqual(['Identifier `n` has already been declared']);
    });
});

describe('a function declaration is lexical in a block, a switch, and at MODULE top level', () => {
    // Strict mode does NOT make a top-level declaration lexical — the module GOAL does. Annex B B.3.3
    // then excuses duplicate PLAIN functions in ONE block, sloppy only. Every line came from oxc.
    //
    // This needed `SymbolRec.at`, the scope a binding was WRITTEN in. Every block function hoists to
    // the enclosing function scope, so two declarations in DIFFERENT blocks share a binding; without
    // `at` the rule rejected `"use strict"; { function f(){} } { function f(){} }`, which is valid,
    // and test262 caught it where a 28-case hand matrix had not.
    it.each(['function f(){} function f(){}', 'async function f(){} async function f(){}'])('rejects %s in a module', (src) => {
        expect(check(src, true)).toEqual(['Identifier `f` has already been declared']);
    });

    it.each([
        '{ async function f(){} async function f(){} }',
        '{ function* f(){} function* f(){} }',
        '{ async function* f(){} async function* f(){} }',
        '{ function f(){} async function f(){} }',
        '{ async function f(){} function f(){} }',
        '"use strict"; { function f(){} function f(){} }',
        'switch(0){ case 1: async function f(){} case 2: async function f(){} }',
        '{ function f(){} var f; }',
        '{ var f; function f(){} }',
    ])('rejects %s — same block, no Annex B excuse', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it.each([
        // DIFFERENT blocks are separate bindings, whatever the mode.
        '{ function f(){} } { function f(){} }',
        '"use strict"; { function f(){} } { function f(){} }',
        '{ async function f(){} } { async function f(){} }',
        '"use strict"; if (1) { function f(){} } if (2) { function f(){} }',
        '"use strict"; function g(){ { function f(){} } { function f(){} } }',
        // Annex B B.3.3: duplicate PLAIN functions in one block, sloppy only.
        '{ function f(){} function f(){} }',
        'switch(0){ case 1: function f(){} case 2: function f(){} }',
        // Var-scoped positions stay var-scoped.
        'function f(){} function f(){}',
        '"use strict"; function f(){} function f(){}',
        'function g(){ function f(){} function f(){} }',
        'function g(){ function f(){} var f; }',
        'function g(){ var f; function f(){} }',
        'class C { m(){ function f(){} function f(){} } }',
        // The Annex B ALIAS against a binding from an OUTER scope.
        '(function(){ var f = 1; { function f(){} } })()',
        'var f; { function f(){} }',
        'let f = 1; { function f(){} }',
        'let f; if (1) function f(){}',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe("Annex B's block-scoped function alias is not a redeclaration", () => {
    // 16 valid test262 programs were rejected over this, and no gate could see it: `checkerdiff`'s
    // corpus has no such shape, and `test262` was not running the checker at all.
    // Annex B covers exactly two positions. Every line below was run through oxc first; generalising
    // from the two that pass to "anywhere nested" wrongly exempts the loop and label forms.
    it.each([
        'let f; { function f(){} }',
        '"use strict"; let f; { function f(){} }',
        'let f; if (1) function f(){}',
        'let f; if (1) ; else function f(){}',
        '(function() { let f = 123; if (true) function f() {} else function _f() {} }());',
        '(function() { var f = 1; { function f() {} } }());',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        'let f; function f(){}',
        'function g(){ let f; function f(){} }',
        'let f; lbl: function f(){}',
        '{ let f; let f; }',
    ])('still rejects %s', (src) => {
        expect(check(src)).toEqual(['Identifier `f` has already been declared']);
    });

    it('a loop body reports BOTH the bad position and the collision, as oxc does', () => {
        // oxc lists the same two, in its own order; ours come out sorted by source position.
        expect(check('let f; while(0) function f(){}')).toEqual([
            'Invalid function declaration',
            'Identifier `f` has already been declared',
        ]);
    });

    it('the `if` exemption does not reach a function nested inside the branch', () => {
        expect(check('let f; if (1) function g(){ let f; function f(){} }')).toEqual([
            'Identifier `f` has already been declared',
        ]);
    });
});

describe('`arguments` is not bound in a class field initializer or a static block', () => {
    it.each([
        'class A { p = arguments; }',
        'class A { p = () => arguments; }',
        'class A { static p = arguments; }',
        'class A { p = class { q = arguments; } }',
        'function f(){ class A { p = arguments; } }',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(["'arguments' is not allowed in class field initializer"]);
    });

    it('a static block carries its own message', () => {
        expect(check('class A { static { arguments; } }')).toEqual(["'arguments' is not allowed in static initialization block"]);
    });

    it.each([
        // An ordinary function has its own `arguments`, so it CLEARS the ban; an arrow does not.
        'class A { p = function(){ return arguments; }; }',
        'class A { static { function f(){ return arguments; } } }',
        'class A { m(){ return arguments; } }',
        // A computed key is evaluated outside the initializer.
        'class A { [arguments] = 1; }',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });
});

describe('`super()` — oxc reports two different messages, and the distinction is the class', () => {
    it.each([
        'class A extends B { constructor() { super(); } }',
        'class A extends B { constructor() { () => super(); } }',
        'class A extends B { constructor() { { super(); } } }',
        'class A extends B { constructor() { class C extends D { constructor(){ super(); } } } }',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        'class A { constructor() { super(); } }',
        'class A extends B { constructor() { class C { constructor(){ super(); } } } }',
    ])('a class with no `extends` complains about the CLASS: %s', (src) => {
        expect(check(src)).toEqual(["'super' can only be referenced in a derived class."]);
    });

    it.each([
        'class A extends B { m() { super(); } }',
        'class A extends B { constructor() { function f(){ super(); } } }',
        'function f() { super(); }',
        'super();',
        '({ m() { super(); } });',
    ])('anywhere else complains about the POSITION: %s', (src) => {
        expect(check(src)).toEqual([
            'Super calls are not permitted outside constructors or in nested functions inside constructors.',
        ]);
    });
});

describe('`super.x` is legal in any class element and in an object-literal method', () => {
    it.each([
        'class A { m() { return super.x; } }',
        'class A { m() { return super["x"]; } }',
        'class A { m() { return () => super.x; } }',
        'class A { p = super.x; }',
        'class A { static { super.x; } }',
        '({ m() { return super.x; } });',
    ])('accepts %s', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        // The context covers PARAMETERS as well as the body — setting it around the body alone
        // rejected four valid test262 programs, all of this shape.
        '({ method(x = super.toString) { return x; } });',
        'class A {} class B extends A { async method(x = super.method()) {} }',
        'class A extends B { constructor(x = super()) {} }',
    ])('accepts %s in a parameter default', (src) => {
        expect(check(src)).toEqual([]);
    });

    it.each([
        '({ m: function() { return super.x; } });',
        'function f() { return super.x; }',
        'super.x;',
        'class A { p = function(){ return super.x; } }',
        'function f(x = super.y){}',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual([
            "'super' can only be referenced in members of derived classes or object literal expressions.",
        ]);
    });
});

describe('duplicate parameters — every verdict here was taken from oxc, not from the spec', () => {
    // The boundary is not where reading the grammar suggests. `UniqueFormalParameters` covers arrows,
    // methods and accessors; everything else uses `FormalParameters`, which permits duplicates in
    // sloppy code — INCLUDING generators and async functions, which is the part that surprises.
    it.each([
        '(a, a) => {}',
        '(a, a = 1) => {}',
        '(a, [a]) => {}',
        'function f(a, a = 1) {}',
        'function f(a, [a]) {}',
        '({ m(a, a) {} });',
        'class C { m(a, a) {} }',
        '"use strict"; function f(a, a) {}',
    ])('rejects %s', (src) => {
        expect(check(src)).toEqual(['Identifier `a` has already been declared']);
    });

    it.each(['function f(a, a) {}', 'function* g(a, a) {}', 'async function h(a, a) {}', '({ m: function (a, a) {} });'])(
        'accepts %s in sloppy code',
        (src) => {
            expect(check(src)).toEqual([]);
        },
    );

    it('the method flag does not leak into a nested ordinary function', () => {
        expect(check('({ m(x) { function g(a, a) {} } });')).toEqual([]);
    });

    it('nor past the method that set it', () => {
        expect(check('class C { m(){} } function f(a, a) {}')).toEqual([]);
    });
});

describe('a jump may not cross a function boundary', () => {
    // Added because SABOTAGING the static-block reset left all 98 tests passing. The rule worked; it
    // was simply unguarded, which is how `1f03586` shipped — `staticBlockDepth` lost its function
    // boundary and harmful went 5 -> 26 while the test262 PASS count ROSE.
    it.each([
        'while(1){ (() => { break; }); }',
        'while(1){ (function(){ break; }); }',
        'while(1){ function f(){ break; } }',
        'while(1){ class C { static { break; } } }',
        'for(;;){ class C { static { continue; } } }',
    ])('%s', (src) => {
        expect(check(src)).toEqual([
            src.includes('continue')
                ? 'Illegal continue statement: no surrounding iteration statement'
                : 'Illegal break statement',
        ]);
    });

    it('a label does not leak across a function boundary either', () => {
        expect(check('a: while(1){ (() => { continue a; }); }')).toEqual(['Use of undefined label']);
    });

    it('but a class body is NOT a boundary for private names', () => {
        expect(check('class C { #y; m(){ return o => o.#y; } }')).toEqual([]);
    });
});

describe('errors are reported in SOURCE order', () => {
    // The separate walk pushed children onto an explicit stack and popped siblings back-to-front, so
    // this reported at 44, 32, 21. oxc reports in source order; fusing the checker into `analyze`
    // fixed it, and this is what keeps it fixed.
    const positions = (src: string) => {
        const { program } = parse(src, { ts: false, jsx: false });
        const sem = createSemantic();
        analyze(sem, program, false, true);
        return sem.errors.map((e) => e.pos);
    };

    it('three errors across sibling statements', () => {
        expect(positions('"use strict"; delete x; var y = 010; delete z;')).toEqual([21, 32, 44]);
    });

    it('a redeclaration is ordered with the rest, not emitted first', () => {
        expect(positions('"use strict"; delete x; function f(a,a){}')).toEqual([21, 37]);
    });

    it('a redeclaration EARLIER than a walk error still sorts first', () => {
        // The case that actually exercises the sort. Redeclarations are judged after the walk, so they
        // are appended last; here the duplicate parameter at 27 precedes the `delete` at 38 in the
        // source, and without the sort they come back as [38, 27]. Sabotaging the sort with only the
        // test above left all 110 passing, because that case was already in order by accident.
        expect(positions('"use strict"; function f(a,a){ delete x; }')).toEqual([27, 38]);
    });
});

describe('a legacy octal in a non-computed property key', () => {
    // `visit` descends into a key only when it is COMPUTED, so this is the one place the fused walk
    // needed a hook the separate walk got for free by visiting every node.
    it.each(['"use strict"; ({ 010: 1 });', '"use strict"; class C { 010(){} }', '"use strict"; ({ [010]: 1 });'])(
        '%s',
        (src) => {
            expect(check(src)).toEqual(["'0'-prefixed octal literals and octal escape sequences are deprecated"]);
        },
    );
});

describe('`analyze` never adds a `scopeId` field a node type did not declare', () => {
    // Replaces a test that checked the checker's hand-maintained `SCOPE_OWNING` list against the defs.
    // That list is gone — the fused walk reads `state.scope` and never touches `node.data.scopeId` —
    // but the invariant UNDER it outlived it, and is the stronger of the two.
    //
    // `newScope` ASSIGNS `scopeId` to every scope-owning node. Four types were receiving it without
    // declaring it (`CatchClause`, `ClassExpression`, `StaticBlock`, `TSModuleDeclaration`), so every
    // catch clause and class expression in every module took a hidden-class transition mid-analysis —
    // against a rule `bundler/transform.ts` states outright: "Must be present at construction so the
    // hidden class is stable." Fixed in `b5c820e`; this is what keeps it fixed.
    it('every node carrying scopeId after analyze declares it in DEFS', () => {
        const src = `
            try { x() } catch (e) { let a }
            const K = class Inner { static { let b } #p = 1; m() { return this.#p } };
            function f() { for (const q of xs) { switch (q) { case 1: { let c } } } }
            label: while (1) break label;
        `;
        const { program } = parse(src, { ts: false, jsx: false });
        analyze(createSemantic(), program, false, true);
        const declares = new Map(
            DEFS.map((d) => [
                (N as unknown as Record<string, number>)[d.name],
                d.fields !== null && Object.hasOwn(d.fields, 'scopeId'),
            ]),
        );
        const undeclared = new Set<string>();
        const walk = (n: Node): void => {
            const d = n.data as Record<string, unknown> | null;
            if (d !== null && Object.hasOwn(d, 'scopeId') && declares.get(n.type) !== true)
                undeclared.add(String((N as unknown as Record<number, string>)[n.type] ?? n.type));
            walkChildren(n, walk);
        };
        walk(program);
        expect([...undeclared]).toEqual([]);
    });
});
