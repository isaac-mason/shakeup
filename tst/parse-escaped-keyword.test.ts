// An escaped spelling still NAMES the keyword: `yield` is `yield` for every reserved-word rule.
//
// oxc gets this almost for free. Its lexer gives the escaped token the KEYWORD's own `Kind`, so a
// single guard in the cursor covers every consumption site:
//
//     // cursor.rs:100
//     if self.token.escaped() && kind.is_any_keyword() { self.report_escaped_keyword(...) }
//
// shakeup's lexer keeps an escaped identifier as an identifier with `F_ESCAPED` + cooked text, so the
// rules consult the cooked name instead. That difference is why two holes existed at once:
//
//   · `yield`/`await` are CONTEXTUAL keywords, and the escaped check exempted all contextual
//     keywords — correct for `async`/`let`/`of`, wrong for the two that become reserved.
//   · a shorthand property never reached `parseIdent` at all, so `({ break })` was accepted even
//     UNESCAPED. That hole is the larger of the two and had nothing to do with escapes.
//
// Messages are oxc's, checked against `oxc-parser` case by case. The shorthand ones are "expected
// ':'" because that is genuinely what oxc reports — it parses the shorthand value as an
// IdentifierReference and its recovery then asks for the `:` that would have made the name a key.
// Binding a contextually-reserved word reports the CONTEXT rather than the escape, which is also
// oxc's ordering: `var await` in an async function is "cannot use `await` as an identifier".
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

// `import.meta` is MODULE-ONLY syntax — node says "Cannot use 'import.meta' outside a module", oxc
// "Unexpected import.meta expression". Gated on an EXPLICIT commonjs goal for the same reason
// `allowTopReturn` and `allowTopNewTarget` are: `unambiguous` stays permissive, so only a file with a
// real signal (`.cjs`/`.cts`, or a declared `package.json#type`) is held to it.
//
// These were the LAST findings in `pnpm parsercorpus`; closing them took that differential to 0 in
// BOTH directions across 4,441 node_modules files.
// A `yield`/`await` EXPRESSION is illegal in the formal parameters of the function whose context it
// belongs to. The boundary is what an ARROW does versus what a nested function does: an arrow inherits
// the surrounding generator/async context, so its parameters are still "inside" it, while an ordinary
// function or a method gets a fresh context and the same word is just an identifier there.
describe('yield/await expressions in a formal parameter list', () => {
    const bad = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each(['function *g(x = yield) {}', 'function *g() { (x = yield) => {}; }', 'function *g() { (x = yield 1) => {}; }'])(
        'rejects %s',
        (src) => {
            expect(bad(src)).toContain('yield expression not allowed in formal parameter');
        },
    );

    it.each(['async function a(x = await 1) {}', 'async function a() { (x = await 1) => {}; }'])('rejects %s', (src) => {
        expect(bad(src)).toContain('await expression not allowed in formal parameter');
    });

    it.each([
        // A nested ORDINARY function gets a fresh context, so `yield` there is an identifier.
        'function *g() { function f(x = yield) {} }',
        'function *g() { (function(x = yield){}); }',
        'function *g() { ({ m(x = yield){} }); }',
        'function f(x = yield) {}',
        // A default may contain a whole generator, and ITS BODY is not a parameter list.
        'function *g(a = function*(){ yield 1 }) {}',
        // Ordinary uses, well away from any parameter list.
        'function *g(a = 1) { yield a; }',
        'async function a(b = 1) { await b; }',
        'function *g(a = () => 1) {}',
    ])('accepts %s', (src) => {
        expect(bad(src)).toEqual([]);
    });
});

// oxc's `error_on_script` (`error_handler.rs:69`) + `deferred_script_errors` (`lib.rs:745-753`):
// under the `unambiguous` goal the module kind is unknown until the parse ends, and several rules are
// errors in a SCRIPT and legal in a MODULE. They are parked and resolved at the end.
//
// This replaced a family of `allow*` booleans, each answering one such question by hand. The mechanism
// generalises where the flags did not: `import.meta` is ITSELF an ESM marker, so under `unambiguous`
// its own deferred error cancels — no flag expressed that. And it brought `for await` at top level
// with it, which we had been ACCEPTING in both script and unambiguous goals.
describe('errors that only hold if the file is a SCRIPT', () => {
    const errs = (src: string, kind: 'module' | 'commonjs' | 'unambiguous') =>
        parse(src, { ts: false, jsx: false, kind }).errors.map((e) => e.msg);

    it('`for await` at top level: rejected in a script, legal in a module', () => {
        expect(errs('for await (const x of y) {}', 'commonjs')).toEqual([
            '`for await` loops are only allowed within async functions and at the top levels of modules',
        ]);
        expect(errs('for await (const x of y) {}', 'module')).toEqual([]);
    });

    it('and under `unambiguous` it stays an error, because `for await` does NOT mark ESM', () => {
        expect(errs('for await (const x of y) {}', 'unambiguous')).not.toEqual([]);
    });

    it('but ESM syntax elsewhere in the file discards it', () => {
        expect(errs('for await (const x of y) {} export var z = 1;', 'unambiguous')).toEqual([]);
    });

    it('inside a NON-async function it is invalid in every goal', () => {
        for (const k of ['commonjs', 'unambiguous', 'module'] as const)
            expect(errs('function f(){ for await (const x of y) {} }', k)).not.toEqual([]);
    });

    it('an async function permits it', () => {
        expect(errs('async function f(){ for await (const x of y) {} }', 'commonjs')).toEqual([]);
    });

    it('`import.meta` cancels its OWN deferred error under `unambiguous`', () => {
        // It is an ESM marker, so the file resolves to a module and the error is discarded.
        expect(errs('import.meta;', 'unambiguous')).toEqual([]);
        expect(errs('import.meta;', 'commonjs')).toEqual(['Unexpected import.meta expression']);
    });
});

describe('import.meta outside a module', () => {
    const goalErrs = (src: string, kind: 'module' | 'commonjs' | 'unambiguous') =>
        parse(src, { ts: false, jsx: false, kind }).errors.map((e) => e.msg);

    it.each(['import.meta.url;', 'function f(){ return import.meta; }', 'new URL("a", import.meta.url);'])(
        'rejects %s under an explicit commonjs goal',
        (src) => {
            expect(goalErrs(src, 'commonjs')).toEqual(['Unexpected import.meta expression']);
        },
    );

    it.each(['import.meta.url;', 'import.meta;'])('accepts %s in a module', (src) => {
        expect(goalErrs(src, 'module')).toEqual([]);
    });

    it('stays permissive under the unambiguous default', () => {
        expect(goalErrs('import.meta.url;', 'unambiguous')).toEqual([]);
    });

    it('leaves dynamic import alone', () => {
        expect(goalErrs('import(x);', 'commonjs')).toEqual([]);
    });
});

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(errs(src), src).not.toEqual([]);
};

describe('a reserved word may not be a shorthand property', () => {
    it.each([
        'var o = { break };',
        'var o = { bre\\u0061k };',
        'var { break } = o;',
        'var { bre\\u0061k } = o;',
        'var x = ({ bre\\u0061k }) => {};',
        'var o = { this };',
        'var o = { class };',
        'var { break = 1 } = o;',
    ])('%s', rejects);

    it('reports what oxc reports', () => {
        expect(msg('var o = { break };')).toMatch(/expected ':'/);
    });

    it('a reserved word is still fine as a KEY', () => {
        expect(errs('var o = { break: 1, if: 2, this: 3, class: 4 };')).toEqual([]);
        expect(errs('x.bre\\u0061k;')).toEqual([]);
    });
});

describe('yield and await are contextual, and become reserved', () => {
    it('escaped, as a binding — reports the context', () => {
        expect(msg('async () => { var \\u0061wait; };')).toBe('cannot use `await` as an identifier in an async context');
        expect(msg('function* g() { var \\u0079ield; }')).toBe('cannot use `yield` as an identifier in a generator context');
    });

    it('escaped, as a reference — reports the escape', () => {
        expect(msg('async () => { void \\u0061wait; };')).toBe('Keywords cannot contain escape characters');
        expect(msg('function* g() { \\u0079ield; }')).toBe('Keywords cannot contain escape characters');
    });

    it('as a shorthand property', () => {
        expect(msg('async () => ({ await });')).toMatch(/expected ':'/);
        expect(msg('async () => ({ \\u0061wait });')).toMatch(/expected ':'/);
    });

    it('and are ordinary identifiers where they are NOT reserved', () => {
        expect(errs('function f() { var \\u0061wait; }')).toEqual([]);
        expect(errs('function f() { var \\u0079ield; }')).toEqual([]);
        expect(errs('var o = { yield, await };')).toEqual([]);
    });
});

describe('what stays legal', () => {
    // The contextual keywords that are never reserved. A false rejection here would break ordinary
    // code — `{ type }` and `{ as }` alone appear throughout real TS — so they are pinned explicitly
    // rather than left to `pnpm parsercorpus` to discover.
    it.each([
        'var o = { async };',
        'var o = { get };',
        'var o = { set };',
        'var o = { of };',
        'var o = { let };',
        'var o = { from };',
        'var o = { type };',
        'var o = { as };',
        'var o = { static };',
        'var o = { source };',
        'var o = { defer };',
        'var o = { meta };',
        'var { async, get, set, of, let } = o;',
        'var o = { async() {} };',
        'var o = { get x() { return 1; } };',
    ])('%s', (src) => {
        expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
        expect(errs(src), src).toEqual([]);
    });
});

// `??` may not be MIXED with `||`/`&&` without parentheses, in either order: the grammar gives
// `CoalesceExpression` its own production rather than a precedence level.
//
// Parentheses are not in our AST, so inspecting the operand NODE reports `(a || b) ?? c` as an error
// too — that was the first cut. What separates them is which FRAME built the node: a parenthesised
// operand is parsed by a fresh `parseBinary` reached through `parseUnary`.
describe('coalesce mixed with logical operators', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each(['a || b ?? c;', 'a && b ?? c;', 'a ?? b || c;', 'a ?? b && c;'])('rejects %s', (src) => {
        expect(errs(src)).toEqual(['Logical expressions and coalesce expressions cannot be mixed']);
    });

    it.each([
        '(a || b) ?? c;',
        'a ?? (b || c);',
        '(a ?? b) || c;',
        'a || (b ?? c);',
        'a ?? b ?? c;',
        'a || b && c;',
        'f(a || b, c ?? d);',
        'a ? b || c : d ?? e;',
    ])('accepts %s', (src) => {
        expect(errs(src)).toEqual([]);
    });
});

// A LexicalDeclaration is not a Statement, so it may not be the body of `if`/`do`/`while`. The
// destructuring form fell through the `let [` disambiguation, which exists because `let[a] = b` is a
// legal member assignment — that ambiguity decides what it PARSES as, not whether the position is
// legal.
describe('a lexical declaration in a single-statement context', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each(['if (1) let [x] = [];', 'do let [x] = [] \n while(false);', 'while(0) let [x] = [];'])('rejects %s', (src) => {
        expect(errs(src)).toEqual(['Lexical declaration cannot appear in a single-statement context']);
    });

    it.each(['let[a] = b;', 'let [x] = [];', 'if (1) { let [x] = []; }'])('accepts %s', (src) => {
        expect(errs(src)).toEqual([]);
    });
});

describe('a private field on `super`, and a computed key without a value', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it('`super.#x` is a SyntaxError', () => {
        // A private name resolves through the class's private environment, which a `super` reference
        // does not carry.
        expect(errs('class C { m(){ super.#x; } }')).toEqual(['Private fields cannot be accessed on super']);
        expect(errs('class C { #x; m(){ return this.#x; } }')).toEqual([]);
        expect(errs('class C { m(){ return super.x; } }')).toEqual([]);
    });

    it.each(['({ [b] });', '({ a, [b] });'])('a computed key has no shorthand form: %s', (src) => {
        // `({ [b] })` is not `({ [b]: b })` — the shorthand takes its VALUE from the name, and a
        // computed key has no name.
        expect(errs(src)).not.toEqual([]);
    });

    it.each(['({ a, [b]: c });', '({ [a]: 1, [b]: 2 });', '({ a, b });'])('accepts %s', (src) => {
        expect(errs(src)).toEqual([]);
    });
});

describe('a class FIELD named `constructor`, and a rest element with a trailing comma', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors.map((e) => e.msg);

    it.each(['class C { "constructor" = 1; }', 'class C { static "constructor" = 1; }'])(
        'rejects %s — banned static or not, unlike a METHOD',
        (src) => {
            expect(errs(src)).toEqual(["Classes can't have a field named 'constructor'"]);
        },
    );

    it.each(['class C { constructor(){} }', 'class C { static constructor(){} }', 'class C { ["constructor"] = 1; }'])(
        'accepts %s',
        (src) => {
            expect(errs(src)).toEqual([]);
        },
    );

    it.each(['[...a,] = [];', '({ ...a, } = {});', '[a, ...b,] = [];'])('a trailing comma after a rest TARGET: %s', (src) => {
        // Legal in the literal, illegal once it becomes a destructuring target — and the comma
        // leaves no trace in the AST, so the parser records it beside the tree.
        expect(errs(src)).toEqual(['A rest parameter or binding pattern may not have a trailing comma.']);
    });

    it.each(['[...a,];', '({ ...a, });', '[...a] = [];', '({ ...a } = {});'])(
        'but the LITERAL keeps its trailing comma: %s',
        (src) => {
            expect(errs(src)).toEqual([]);
        },
    );

    it.each(['({ 0 });', '({ "a" });'])('a literal key has no shorthand form: %s', (src) => {
        expect(errs(src)).not.toEqual([]);
    });
});

describe('accessor parameter lists, `using` placement, and ill-formed export names', () => {
    const errs = (src: string, ts = false) => parse(src, { ts, jsx: false, kind: 'module' }).errors.map((e) => e.msg);

    it.each(['class C { get x(a){} }', 'class C { get x(a = 1){} }', '({ get x(a){} });'])(
        'a getter takes no parameters: %s',
        (src) => {
            expect(errs(src)).toEqual(["A 'get' accessor must not have any formal parameters."]);
        },
    );

    it.each(['class C { set x(){} }', 'class C { set x(a,b){} }', '({ set x(){} });'])(
        'a setter takes exactly one: %s',
        (src) => {
            expect(errs(src)).toEqual(["A 'set' accessor must have exactly one parameter."]);
        },
    );

    it.each(['class C { set x(...a){} }', '({ set x(...a){} });'])(
        'and that one may not be a rest: %s — oxc reports the COUNT first, so this needs count 1',
        (src) => {
            expect(errs(src)).toEqual(["A 'set' accessor cannot have rest parameter."]);
        },
    );

    it('a TS `this` parameter is not a parameter for the arity rule', () => {
        expect(errs('class C { set x(this: C, v: number){} get y(): number { return 1; } }', true)).toEqual([]);
    });

    it.each(['class C { get x(){} set y(v){} }', '({ get x(){}, set y(v){} });'])('accepts %s', (src) => {
        expect(errs(src)).toEqual([]);
    });

    it.each(['switch(x){case 1: using a = null;}', 'switch(x){default: using a = null;}'])(
        'a `using` declaration may not sit bare in a case clause: %s',
        (src) => {
            expect(errs(src)).toEqual(["'using' declaration cannot appear in the bare case statement."]);
        },
    );

    it('and neither may `await using`', () => {
        expect(errs('async function f(){ switch(x){case 1: await using a = null;} }')).toEqual([
            "'await using' declaration cannot appear in the bare case statement.",
        ]);
    });

    it.each(['switch(x){case 1: { using a = null; } }', 'switch(x){case 1: var a = null;}'])(
        'a block or a `var` is fine: %s',
        (src) => {
            expect(errs(src)).toEqual([]);
        },
    );

    it('a `using` declarator may not be a binding pattern — checked per declarator', () => {
        // The FIRST declarator is what settles that this is a using declaration at all; `using [a]`
        // on its own stays a member expression, and oxc accepts it.
        expect(errs('using a = null, [b] = null;')).toEqual(['Using declarations may not have binding patterns.']);
        expect(errs('using [a] = null;')).toEqual([]);
    });

    it.each(['var x; export { x as "\uD83D" };', 'import { "\uD83D" as y } from "m";', 'export * as "\uD83D" from "m";'])(
        'an export name may not carry a lone surrogate: %s',
        (src) => {
            expect(errs(src)).toEqual(['An export name cannot include a unicode lone surrogate']);
        },
    );

    it.each([
        'var x; export { x as "\\uD83D\\uDE00" };',
        'var x; export { x as "\\u{1F600}" };',
        'var x; export { x as "a-b" };',
        'export * as "ok" from "m";',
    ])('a well-formed one is fine: %s', (src) => {
        expect(errs(src)).toEqual([]);
    });
});

describe('`throw` newlines, duplicate import attributes, import phases and escaped `import.meta`', () => {
    const errs = (src: string) => parse(src, { ts: false, jsx: false, kind: 'module' }).errors.map((e) => e.msg);

    it('a newline after `throw` does not trigger ASI — it makes the statement illegal', () => {
        expect(errs('try { throw\n1; } catch(e) {}')).toEqual(['Illegal newline after throw']);
        expect(errs('throw 1;')).toEqual([]);
        expect(errs('throw (\n1);')).toEqual([]);
    });

    it('duplicate import-attribute keys are keyed on the VALUE, so an escape still collides', () => {
        expect(errs("import x from './m.js' with { type: 'json', type: 'js' };")).toEqual([
            'Identifier `type` has already been declared',
        ]);
        expect(errs(String.raw`export * from './m.js' with { type: 'json', 'typ\u0065': '' };`)).toEqual([
            'Identifier `type` has already been declared',
        ]);
        expect(errs("import x from './m.js' with { type: 'json', other: 'js' };")).toEqual([]);
        expect(errs("import x from './m.js' with { 'a-b': 'json' };")).toEqual([]);
    });

    it('each import phase admits exactly one specifier form', () => {
        expect(errs('import defer x, * as ns from "./m.js";')).toEqual(['Default imports are not allowed in a deferred import.']);
        expect(errs('import defer { a } from "./m.js";')).toEqual(['Named imports are not allowed in a deferred import.']);
        expect(errs('import source * as w from "./m.wasm";')).toEqual([
            'Only a single default import is allowed in a source phase import.',
        ]);
        expect(errs('import source { a } from "./m.wasm";')).toEqual([
            'Only a single default import is allowed in a source phase import.',
        ]);
    });

    it.each([
        'import defer * as ns from "./m.js";',
        'import source w from "./m.wasm";',
        // `defer` and `source` are contextual, so these are ordinary DEFAULT imports of a binding
        // named `defer` / `source` and carry no phase at all.
        'import defer from "./m.js";',
        'import source from "./m.wasm";',
    ])('accepts %s', (src) => {
        expect(errs(src)).toEqual([]);
    });

    it('`meta` is a keyword to the import-meta rule, so an escaped spelling is rejected', () => {
        expect(errs(String.raw`import.m\u0065ta;`)).toEqual(['Keywords cannot contain escape characters']);
        expect(errs('import.meta;')).toEqual([]);
    });
});
