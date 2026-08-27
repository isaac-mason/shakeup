/**
 * Differential PARSER conformance: shakeup vs the real oxc parser (`oxc-parser`), on ACCEPT/REJECT.
 *
 * Run: `pnpm parserdiff` · `pnpm parserdiff <substring>` to filter.
 *
 * shakeup's AST is its own shape (a monomorphic node+data layout, deliberately — see
 * `parser-perf-focus`), so a structural AST diff is not possible and would not be the interesting
 * question anyway. What IS checkable, and what actually bit this project, is the GRAMMAR DECISION:
 * given a source and a module goal, does the parser accept it or reject it?
 *
 * That is the surface the CommonJS work touched — top-level `return`, top-level `await`,
 * `new.target`, `this`, and `import`/`export` legality all depend on the declared goal, and oxc
 * gates each one differently.
 *
 * TWO of the three goals map exactly: oxc `module` ↔ shakeup `module`, oxc `commonjs` ↔ shakeup
 * `commonjs`. Both directions of disagreement are findings there.
 *
 * The third does NOT map. shakeup's `unambiguous` is not oxc's `script`: it is the goal used when
 * nothing has declared one yet, so it deliberately accepts a SUPERSET and lets detection decide
 * afterwards. Only one direction is meaningful — `unambiguous` must accept everything `script`
 * accepts. Being more permissive is the design; being less is a bug. Scoring it symmetrically was
 * the harness's own first bug, and inflated the divergence count by nine.
 *
 * A disagreement printed here is a fact. Intended ones are in `EXPECTED` with a reason.
 */
import { parseSync } from 'oxc-parser';
import { type ParseKind, parseWithDiagnostics } from '../src/parser/parser.ts';

type Goal = 'module' | 'commonjs' | 'script';
type Case = { name: string; src: string; goals?: Goal[] };

const ALL: Goal[] = ['module', 'commonjs', 'script'];

/** oxc goal → shakeup `ParseKind`. oxc's `script` is "not a module and not CJS-wrapped", which is
 *  shakeup's `unambiguous` — the goal it uses when nothing has declared one. */
const asKind = (g: Goal): ParseKind => (g === 'script' ? 'unambiguous' : g);

const EXPECTED: Record<string, string> = {};

const CASES: Case[] = [
    // ── module-goal gating: the surface the CommonJS work touched ──
    { name: 'top-level return', src: 'return 1;' },
    { name: 'top-level return, nested in a block', src: '{ return 1; }' },
    { name: 'return inside a function', src: 'function f() { return 1 }' },
    { name: 'top-level await', src: 'await 1;' },
    { name: 'top-level await in a for-of', src: 'for await (const x of []) {}' },
    { name: 'await inside an async function', src: 'async function f() { await 1 }' },
    { name: 'await as an identifier', src: 'var await = 1;' },
    { name: 'await as an identifier in an async fn', src: 'async function f() { var await = 1 }' },
    { name: 'top-level new.target', src: 'new.target;' },
    { name: 'new.target inside a function', src: 'function f() { return new.target }' },
    { name: 'new.target inside an arrow', src: 'const f = () => new.target;' },
    { name: 'top-level this', src: 'this.x = 1;' },
    { name: 'import declaration', src: "import a from 'b';" },
    { name: 'export declaration', src: 'export const a = 1;' },
    { name: 'export default', src: 'export default 1;' },
    { name: 'import.meta', src: 'import.meta.url;' },
    { name: 'dynamic import', src: "import('./x');" },
    { name: 'import.meta in a function', src: 'function f() { return import.meta }' },
    // ── strictness: a module is implicitly strict, a script is not ──
    { name: 'with statement', src: 'with ({}) {}' },
    { name: 'octal literal', src: 'var x = 0777;' },
    { name: 'delete of an identifier', src: 'var x; delete x;' },
    { name: 'duplicate parameter names', src: 'function f(a, a) {}' },
    { name: 'assignment to eval', src: 'eval = 1;' },
    { name: 'arguments as a binding', src: 'var arguments = 1;' },
    { name: 'implicit octal escape in a string', src: "var s = '\\101';" },
    // ── general grammar, goal-independent ──
    { name: 'class private field', src: 'class C { #x = 1; m() { return this.#x } }' },
    { name: 'private brand check', src: 'class C { #x; static has(o) { return #x in o } }' },
    { name: 'static block', src: 'class C { static { this.x = 1 } }' },
    { name: 'optional chaining call', src: 'a?.b?.();' },
    { name: 'nullish assignment', src: 'a ??= 1;' },
    { name: 'logical assignment', src: 'a ||= 1; b &&= 2;' },
    { name: 'exponent', src: 'a ** b ** c;' },
    { name: 'numeric separators', src: 'var x = 1_000_000;' },
    { name: 'bigint', src: 'var x = 1n;' },
    { name: 'object spread', src: 'var o = { ...a, b: 1 };' },
    { name: 'array holes', src: 'var a = [1, , 3];' },
    { name: 'destructuring with defaults', src: 'const { a = 1, b: { c } = {} } = o;' },
    { name: 'destructuring assignment to a member', src: '({ a: o.x } = y);' },
    { name: 'labelled continue', src: 'outer: for (;;) { continue outer }' },
    { name: 'regex with a slash in a class', src: 'var r = /[/]/;' },
    { name: 'regex named groups', src: 'var r = /(?<y>\\d{4})/u;' },
    { name: 'regex v flag', src: 'var r = /[\\p{ASCII}]/v;' },
    { name: 'tagged template', src: 'tag`a${b}c`;' },
    { name: 'nested template', src: '`a${`b${c}d`}e`;' },
    { name: 'generator delegate', src: 'function* g() { yield* h() }' },
    { name: 'async generator', src: 'async function* g() { yield 1 }' },
    { name: 'getter and setter', src: 'var o = { get a() { return 1 }, set a(v) {} };' },
    { name: 'computed class member', src: 'class C { [x]() {} }' },
    { name: 'trailing comma in params', src: 'function f(a, b,) {}' },
    { name: 'arrow with a single destructured param', src: 'const f = ({ a }) => a;' },
    { name: 'sequence in a for head', src: 'for (a = 1, b = 2; ; ) break;' },
    { name: 'in-operator in a for head', src: "for (var x = 'a' in {}; ; ) break;" },
    { name: 'ASI: return on its own line', src: 'function f() { return\n1 }' },
    { name: 'ASI: no semicolon before a bracket', src: 'var a = 1\n[1].forEach(x => x)' },
    { name: 'hashbang', src: '#!/usr/bin/env node\nvar a = 1;' },
    { name: 'unicode identifier', src: 'var \\u0061 = 1;' },
    // ── things that must be REJECTED ──
    { name: 'invalid: let let', src: 'let let = 1;' },
    { name: 'invalid: duplicate lexical binding', src: 'let a = 1; let a = 2;' },
    { name: 'invalid: break outside a loop', src: 'break;' },
    { name: 'invalid: yield outside a generator', src: 'function f() { yield 1 }' },
    { name: 'invalid: new.target at top level of an arrow chain', src: 'const f = () => { new.target };' },
    { name: 'invalid: assignment to a call', src: 'f() = 1;' },
    { name: 'invalid: class constructor generator', src: 'class C { *constructor() {} }' },
    { name: 'invalid: unterminated string', src: "var s = 'abc" },
    { name: 'invalid: reserved word binding', src: 'var class = 1;' },
    { name: 'invalid: private field outside a class', src: 'this.#x;' },
    // ── EARLY ERRORS: the grammar accepts the shape, a later rule rejects it ──
    // Assignment targets (13.15.1 + the destructuring cover grammar, oxc `js/grammar.rs`).
    { name: 'invalid: assign to a literal', src: '1 = 2;' },
    { name: 'invalid: assign to `this`', src: 'this = 1;' },
    { name: 'invalid: assign to a binary expression', src: '(a + b) = 1;' },
    { name: 'invalid: assign to a sequence', src: '(a, b) = 1;' },
    { name: 'invalid: assign to a conditional', src: '(a ? b : c) = 1;' },
    { name: 'invalid: assign to a template', src: '`t` = 1;' },
    { name: 'invalid: assign to an optional chain', src: 'a?.b = 1;' },
    { name: 'invalid: compound-assign to a call', src: 'f() += 1;' },
    { name: 'invalid: compound-assign to a pattern', src: '[a] += b;' },
    { name: 'invalid: logical-assign to a call', src: 'f() ||= 1;' },
    { name: 'invalid: prefix update on a call', src: '++f();' },
    { name: 'invalid: postfix update on a call', src: 'f()--;' },
    { name: 'invalid: prefix update on a literal', src: '++1;' },
    { name: 'invalid: for-in head is a call', src: 'for (f() in {}) ;' },
    { name: 'invalid: for-of head is a call', src: 'for (f() of []) ;' },
    { name: 'invalid: array target holds a call', src: '[f()] = [];' },
    { name: 'invalid: object target holds a call', src: '({ a: f() } = {});' },
    { name: 'invalid: array target holds a literal', src: '[1] = b;' },
    { name: 'invalid: default with a non-`=` operator', src: '[a ||= 1] = b;' },
    { name: 'invalid: rest is not last', src: '[...a, b] = c;' },
    { name: 'invalid: rest target is a call', src: '[...f()] = b;' },
    { name: 'invalid: object rest target is a pattern', src: '({ ...{ a } } = b);' },
    { name: 'valid: destructuring assignment', src: '[a, [b], { c }, ...d] = e;' },
    { name: 'valid: object destructuring with defaults', src: '({ a = 1, b: c = 2, ...d } = e);' },
    { name: 'valid: array rest holds a pattern', src: '[...[a]] = b;' },
    { name: 'valid: member targets', src: '[a.b, a[c], ({}).d] = e;' },
    // `yield` is contextual: an operator only inside a generator, an identifier everywhere else.
    { name: 'invalid: yield in a plain function', src: 'function f() { yield 1 }' },
    { name: 'invalid: yield in a method', src: 'var o = { m() { yield 1 } };' },
    { name: 'invalid: yield in a class method', src: 'class C { m() { yield 1 } }' },
    { name: 'invalid: yield in an async function', src: 'async function f() { yield 1 }' },
    { name: 'invalid: yield in a function nested in a generator', src: 'function* g() { function h() { yield 1 } }' },
    { name: 'invalid: yield in an arrow nested in a generator', src: 'function* g() { (() => yield 1) }' },
    { name: 'invalid: bind `yield` in a generator', src: 'function* g() { var yield = 1 }' },
    { name: 'valid: yield as an identifier outside a generator', src: 'var yield = 1; yield; f(a = yield);' },
    { name: 'valid: yield as an arrow parameter', src: 'function f() { yield => 1 }' },
    { name: 'valid: yield in a generator method', src: 'var o = { *m() { yield 1 } }; class C { *n() { yield 1 } }' },
    // Constructor form, and the reserved private name.
    { name: 'invalid: generator constructor', src: 'class C { *constructor() {} }' },
    { name: 'invalid: async constructor', src: 'class C { async constructor() {} }' },
    { name: 'invalid: getter named constructor', src: 'class C { get constructor() {} }' },
    { name: 'invalid: setter named constructor', src: 'class C { set constructor(v) {} }' },
    { name: 'invalid: generator string-keyed constructor', src: 'class C { *"constructor"() {} }' },
    { name: 'invalid: #constructor', src: 'class C { #constructor() {} }' },
    { name: 'valid: static members named constructor', src: 'class C { static *constructor() {} static get constructor() {} }' },
    { name: 'valid: computed key named constructor', src: 'class C { ["constructor"]() {} }' },
    // `new.target` needs an enclosing FUNCTION; an arrow does not supply one.
    { name: 'invalid: new.target in a top-level arrow', src: 'const f = () => new.target;' },
    { name: 'invalid: new.target in a top-level arrow block', src: 'const f = () => { new.target };' },
    { name: 'valid: new.target in an arrow inside a function', src: 'function f() { return () => new.target }' },
];

const filter = process.argv[2];
const cases = filter === undefined ? CASES : CASES.filter((c) => c.name.includes(filter));

const oxcAccepts = (src: string, goal: Goal): boolean => {
    try {
        return parseSync('t.js', src, { sourceType: goal }).errors.length === 0;
    } catch {
        return false;
    }
};

const shakeupAccepts = (src: string, goal: Goal): boolean => {
    try {
        return parseWithDiagnostics(src, { ts: false, jsx: false, kind: asKind(goal) }).errors.length === 0;
    } catch {
        return false;
    }
};

let diverged = 0;
let expected = 0;
const rows: string[] = [];
for (const c of cases) {
    const goals = c.goals ?? ALL;
    const bad: string[] = [];
    for (const g of goals) {
        const o = oxcAccepts(c.src, g);
        const s = shakeupAccepts(c.src, g);
        if (o === s) continue;
        // `unambiguous` is a deliberate superset of `script` — only a REJECTION it should not make
        // is a finding.
        if (g === 'script' && s) continue;
        bad.push(`${g}: oxc ${o ? 'accepts' : 'rejects'}, shakeup ${s ? 'accepts' : 'rejects'}`);
    }
    if (bad.length === 0) {
        rows.push(`  ok   ${c.name}`);
        continue;
    }
    const known = EXPECTED[c.name];
    if (known !== undefined) expected++;
    else diverged++;
    rows.push(`${known !== undefined ? ' note ' : ' DIFF '} ${c.name}`);
    for (const b of bad) rows.push(`         ${b}`);
    if (known !== undefined) rows.push(`         reason:  ${known}`);
}
console.log(rows.join('\n'));
console.log(
    `\n${cases.length} cases x ${ALL.length} goals · ${cases.length - diverged - expected} agree · ${expected} expected-different · ${diverged} UNEXPLAINED`,
);
process.exit(diverged === 0 ? 0 : 1);
