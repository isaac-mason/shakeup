import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

// The SCRIPT goal — what a `<script>` tag has, and what test262 means by "not a module". oxc's
// `SourceType::script()`. shakeup had `module`, `commonjs` and `unambiguous` and nothing for this,
// so the conformance harness was handing shakeup `unambiguous` while asking oxc for `script`: two
// different languages compared against each other, worth 14 of the parser-layer misses on its own.
//
// It is NOT CommonJS. A top-level `return` is legal in CJS only because Node wraps the body in a
// function, and `unambiguous` reads one as EVIDENCE of CJS — a Script has no wrapper, so the spec
// rejects it. Every rule below was verified against `oxc-parser` with `sourceType: 'script'` before
// it was written.
const errs = (src: string, kind: 'script' | 'module' | 'commonjs' | 'unambiguous') =>
    parse(src, { ts: false, jsx: false, kind }).errors;
const accepts = (src: string, kind: 'script' | 'module' | 'commonjs' | 'unambiguous') => errs(src, kind).length === 0;

describe('the script goal rejects what a Script may not contain', () => {
    it.each([
        ['a top-level return', 'return 1;'],
        ['new.target at top level', 'new.target;'],
        ['new.target in a top-level arrow', 'var f = () => new.target;'],
        ['import.meta', 'import.meta;'],
    ])('rejects %s', (_name, src) => {
        expect(accepts(src, 'script'), 'script rejects it').toBe(false);
        // CommonJS keeps `return` and `new.target` because Node's wrapper is a real function, and
        // `unambiguous` cannot know yet — so neither may be tightened by this.
        if (src !== 'import.meta;') expect(accepts(src, 'commonjs'), 'CommonJS still accepts it').toBe(true);
        expect(accepts(src, 'unambiguous'), 'unambiguous stays permissive').toBe(true);
    });

    it('still allows them where a Script genuinely may have them', () => {
        expect(accepts('function f() { return 1; }', 'script')).toBe(true);
        expect(accepts('function f() { new.target; }', 'script')).toBe(true);
    });
});

describe('the script goal keeps what only a MODULE may not contain', () => {
    // Three separate rules were keyed on `allowTopReturn`, which was the same test as "is a module"
    // only because that flag happened to be false for modules alone. Adding this goal broke all
    // three at once: `with` newly rejected 297 valid sloppy programs and HTML-like comments another
    // 6. Both are Script-legal and Module-illegal, so they are keyed on the goal being a MODULE now.
    it.each([
        ['a with statement', 'with ({}) { }'],
        ['an HTML close comment', 'var c = 0;\n/*\n*/-->\nc += 1;\n'],
        ['an HTML open comment', '<!-- comment\nvar x = 1;\n'],
    ])('accepts %s in a script and rejects it in a module', (_name, src) => {
        expect(accepts(src, 'script'), 'Annex B / sloppy Script permits it').toBe(true);
        expect(accepts(src, 'module'), 'a module does not').toBe(false);
        expect(accepts(src, 'unambiguous'), 'unambiguous is unchanged').toBe(true);
    });
});

describe('the script goal has no module items, and no top-level using', () => {
    // A Script's grammar has no ImportDeclaration or ExportDeclaration at all, and Annex-B aside,
    // `using` is a module-or-nested form. shakeup parses ESM under EVERY goal because it is a
    // bundler, so these are the first rules it has ever had for the shape — they fire for `script`
    // and nothing else. All four positions verified against `oxc-parser`.
    it.each([
        ['an import declaration', "import x from 'y';"],
        ['an export declaration', 'export var x = 1;'],
        ['an export default', 'export default 1;'],
        ['a top-level using', 'using x = null;'],
        ['a top-level await using', 'await using x = null;'],
    ])('rejects %s', (_name, src) => {
        expect(accepts(src, 'script'), 'script rejects it').toBe(false);
        expect(accepts(src, 'module'), 'a module does not').toBe(true);
        expect(accepts(src, 'unambiguous'), 'unambiguous is unchanged').toBe(true);
    });

    it.each([
        ['a dynamic import CALL, which is an expression', "import('y');"],
        ['using inside a block', '{ using x = null; }'],
        ['using inside a function', 'function f(){ using x = null; }'],
        ['await using inside an async function', 'async function f(){ await using x = null; }'],
    ])('still accepts %s', (_name, src) => {
        expect(accepts(src, 'script')).toBe(true);
    });

    it('reports the message oxc reports', () => {
        expect(errs("import x from 'y';", 'script')[0].msg).toBe('Cannot use import statement outside a module');
        expect(errs('export var x = 1;', 'script')[0].msg).toBe('Cannot use export statement outside a module');
        expect(errs('using x = null;', 'script')[0].msg).toBe(
            "'using' declarations are not allowed at the top level of a script",
        );
    });
});

// The last three rules the `pnpm misslayers` porting queue held, other than `with` itself (a stated
// non-goal). Each was verified against `oxc-parser` in every position before being written, and each
// turned out to live in a different layer — one was already implemented and only miscategorised.
describe('the last of the checker porting queue', () => {
    const check = (src: string) => {
        const r = parse(src, { ts: false, jsx: false, kind: 'script' });
        if (r.errors.length > 0) return r.errors.map((e) => e.msg);
        const sem = createSemantic();
        analyze(sem, r.program, false, true);
        return sem.errors.map((e) => e.msg);
    };

    it('reserves `yield` in a class static block, even inside a generator', () => {
        // A static block is parsed `[~Yield, +Await]`: an enclosing generator does not reach into it.
        // `CTX.Yield` was left set, so the `yield` parsed as a YieldExpression and walked straight
        // past the strict-mode reserved-word rule that already rejected the same code at top level.
        expect(check('function * g() {\n class C { static { yield; } }\n}')).toEqual(["The keyword 'yield' is reserved"]);
        expect(check('class C { static { yield; } }')).toEqual(["The keyword 'yield' is reserved"]);
        // Still a YieldExpression where one is actually allowed.
        expect(check('function * g() { yield 1; }')).toEqual([]);
    });

    it('rejects a function declaration as the body of `with`, like a loop body', () => {
        // The checker rule already existed and is untouched; `with` simply had no `stmtPos`
        // classification, so the body reached it as STMT_POS_NONE and it returned early. Annex B
        // B.3.3 reaches an `if`/`else` body and a label, and nothing else.
        expect(check('with ({}) function f() {}')).toEqual(['Invalid function declaration']);
        for (const src of ['while (0) function f() {}', 'do function f() {} while (0);', 'for (;;) function f() {}'])
            expect(check(src), src).toEqual(['Invalid function declaration']);
        for (const src of ['if (1) function f() {}', 'if (1) {} else function f() {}', 'l: function f() {}'])
            expect(check(src), src).toEqual([]);
    });

    it('rejects two bindings of one name inside a catch parameter', () => {
        expect(check('try { } catch ([x, x]) {}')).toEqual(['Identifier `x` has already been declared']);
        expect(check('try { } catch ({a: x, b: x}) {}')).toEqual(['Identifier `x` has already been declared']);
        // Annex B B.3.5 — a `var` may redeclare a SIMPLE catch parameter, and must keep doing so.
        expect(check('try {} catch (e) { var e; }')).toEqual([]);
        expect(check('try { } catch ([a, b]) {}')).toEqual([]);
        // The DESTRUCTURING form of B.3.5 is not exempt, and was already caught elsewhere.
        expect(check('try {} catch ([e]) { var e; }')).toEqual(['Identifier `e` has already been declared']);
    });
});

// An escaped identifier used as a LABEL. Not just a missed diagnostic: the label's NAME in the AST
// was the raw source slice, so `yield:` and `yield:` were two different labels — a duplicate
// went unreported and a `break` could fail to match its label. Node treats them as one (verified
// with `new Function`), and so does oxc.
describe('an escaped label carries its cooked name', () => {
    const check = (src: string, strict = false) => {
        const r = parse(`${strict ? '"use strict";\n' : ''}${src}`, { ts: false, jsx: false, kind: 'script' });
        if (r.errors.length > 0) return r.errors.map((e) => e.msg);
        const sem = createSemantic();
        analyze(sem, r.program, false, true);
        return sem.errors.map((e) => e.msg);
    };

    it('is the SAME label as its unescaped spelling', () => {
        // Both directions, because the bug made the label and the `break` disagree either way.
        expect(check('yi\\u0065ld: { break yield; }')).toEqual([]);
        expect(check('yield: { break yi\\u0065ld; }')).toEqual([]);
        // The pair collides, exactly as node reports it.
        expect(check('yield: yi\\u0065ld: 1;')).toEqual(['Label `yield` has already been declared']);
    });

    it('is held to the strict-mode reserved-word rule the unescaped spelling is', () => {
        expect(check('yi\\u0065ld: 1;', true)).toEqual(["The keyword 'yield' is reserved"]);
        expect(check('l\\u0065t: 1;', true)).toEqual(["The keyword 'let' is reserved"]);
        // Sloppy code reserves neither, escaped or not.
        expect(check('yi\\u0065ld: 1;')).toEqual([]);
        expect(check('l\\u0065t: 1;')).toEqual([]);
    });
});

// The harmful direction: programs shakeup REJECTED that are valid. Worse than a missed early error,
// because a build fails on correct input. Both shapes verified against `oxc-parser` across every
// neighbouring position before the fix, so the NEGATIVE cases are pinned as tightly as the positive.
describe('valid programs that were wrongly rejected', () => {
    const ok = (src: string) => parse(src, { ts: false, jsx: false, kind: 'script' }).errors.length === 0;

    it("allows `-->` after only whitespace or comments on its line", () => {
        // Annex B B.1.1: a SingleLineHTMLCloseComment may be preceded on its line by whitespace,
        // line terminators and comments. The test read `pos === 0`, which is only the same thing
        // when there is no leading trivia at all — one leading space was enough to break it.
        expect(ok('--> a comment\nvar x = 1;'), 'at position 0').toBe(true);
        expect(ok('   --> a comment\nvar x = 1;'), 'after leading whitespace').toBe(true);
        expect(ok('/* c */ --> a comment\nvar x = 1;'), 'after a block comment').toBe(true);
        expect(ok('var y = 1;\n--> a comment\n'), 'on a later line').toBe(true);
        // Still NOT a comment when real code precedes it on the same line — oxc rejects both.
        expect(ok('var y = 1; --> a comment\n'), 'after code on the same line').toBe(false);
        expect(ok('y --> a comment\n'), 'after an expression').toBe(false);
    });

    it('reads `get`/`set` followed by `*` as the member NAME, not an accessor keyword', () => {
        // An accessor is never a generator, so `*` cannot begin its name: `get` is the field, and
        // ASI supplies the `;`. Rejecting it cost two of the five harmful misses.
        expect(ok('class A {\n  get\n  *a() {}\n}')).toBe(true);
        expect(ok('class A {\n  set\n  *a() {}\n}')).toBe(true);
        expect(ok('class B {\n  static get\n  *a() {}\n}')).toBe(true);
        // On ONE line there is no ASI, so it stays an error — as oxc reports it too.
        expect(ok('class A { get *a() {} }')).toBe(false);
        // And `*` after every OTHER modifier is an ordinary generator method, which is why the
        // `starEnds` opt-in is confined to the accessor sites: adding it to the shared helper broke
        // `static *constructor(){}`, `async *g(){}` and `static async *m(){}` at once.
        expect(ok('class C { static *constructor() {} }')).toBe(true);
        expect(ok('class C { static async *m(a) { return a; } }')).toBe(true);
        expect(ok('x = { async *g() {} };')).toBe(true);
    });
});

// Annex B B.3.6 — the last harmful miss in test262, and the narrowest of the Annex B extensions.
// It needs BOTH layers: the parser has no notion of strict mode, so it accepts the shape and the
// checker rejects it under a directive — the split `with` already uses. Every row below was mapped
// against `oxc-parser` before the rule was written.
describe('Annex B allows an initializer in a for-in head, and only there', () => {
    const check = (src: string) => {
        const r = parse(src, { ts: false, jsx: false, kind: 'script' });
        if (r.errors.length > 0) return r.errors.map((e) => e.msg);
        const sem = createSemantic();
        analyze(sem, r.program, false, true);
        return sem.errors.map((e) => e.msg);
    };
    const ok = (src: string) => check(src).length === 0;

    it('accepts `for (var a = 1 in obj)` in sloppy code', () => {
        expect(ok('for (var a = 1 in {});')).toBe(true);
        expect(ok('function f(){ for (var a = ++e in {}); }')).toBe(true);
    });

    it('rejects it under strict mode, where Annex B does not reach', () => {
        const msg = 'for-in loop variable declaration may not have an initializer';
        expect(check('"use strict";\nfor (var a = 1 in {});')).toEqual([msg]);
        expect(check('function f(){ "use strict"; for (var a = 1 in {}); }')).toEqual([msg]);
        // A MODULE is always strict, which is why the bundler — which only ever parses modules —
        // still refuses this. oxc rejects the module form too.
        const r = parse('for (var a = 1 in {});', { ts: false, jsx: false, kind: 'module' });
        const sem = createSemantic();
        if (r.errors.length === 0) analyze(sem, r.program, true, true);
        expect(r.errors.length + sem.errors.length).toBeGreaterThan(0);
    });

    it.each([
        ['let', 'for (let a = 1 in {});'],
        ['const', 'for (const a = 1 in {});'],
        ['an array pattern', 'for (var [a] = 1 in {});'],
        ['an object pattern', 'for (var {a} = 1 in {});'],
        ['for-of', 'for (var a = 1 of []);'],
    ])('still rejects %s, which Annex B does not cover', (_n, src) => {
        expect(ok(src)).toBe(false);
    });

    it('leaves an ordinary for-in and an ordinary for alone', () => {
        expect(ok('for (var a in {});')).toBe(true);
        expect(ok('for (var a = 1;;) break;')).toBe(true);
    });
});

// `with` is a STRICT-MODE error, not a module one — the last non-regex test262 miss. The parser
// rejects it whenever the goal is a module (always strict) and can do no better, because it tracks
// no strict mode; a strict SCRIPT therefore reached the checker unchecked. oxc splits it identically.
describe('`with` is rejected by strictness, not by goal', () => {
    const check = (src: string, kind: 'script' | 'module' = 'script') => {
        const r = parse(src, { ts: false, jsx: false, kind });
        if (r.errors.length > 0) return r.errors.map((e) => e.msg);
        const sem = createSemantic();
        analyze(sem, r.program, kind === 'module', true);
        return sem.errors.map((e) => e.msg);
    };
    const msg = "'with' statements are not allowed";

    it('is legal in a sloppy script, at any depth', () => {
        expect(check('with ({}) {}')).toEqual([]);
        expect(check('function f(){ with ({}) {} }')).toEqual([]);
    });

    it.each([
        ['a directive at the top', '"use strict";\nwith ({}) {}'],
        ['a directive in the enclosing function', 'function f(){ "use strict"; with ({}) {} }'],
        ['a class body, which is always strict', 'class C { m() { with ({}) {} } }'],
    ])('is rejected under %s', (_n, src) => {
        expect(check(src)).toEqual([msg]);
    });

    it('is still rejected outright in a module', () => {
        // The parser owns this one and reports its own wording; what matters is that it rejects.
        expect(check('with ({}) {}', 'module').length).toBeGreaterThan(0);
    });
});
