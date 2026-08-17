import { describe, expect, it } from 'vitest';
import { applyEdits, collectStripEdits, emitModule, type JSXLower, parse } from '../src/index.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';
import { astEqual, semanticEqual } from './print-helpers.ts';

function roundTrip(src: string, minify: boolean): { printed: string; equal: boolean } {
    const original = parse(src, { ts: false, jsx: false }).program;
    const p = createPrinter({ minify });
    printModule(p, original);
    const printed = finishPrinter(p);
    const reparsed = parse(printed, { ts: false, jsx: false });
    // Non-minify is whitespace-faithful (strict); minify takes legal syntactic freedoms (semantic).
    const eq = minify ? semanticEqual : astEqual;
    const equal = reparsed.errors.length === 0 && eq(original, reparsed.program);
    return { printed, equal };
}

/** TS parity: the printer's type-stripped output must be structurally identical to the
 *  proven edit engine's strip (both re-parsed as JS). This is Phase-1 gate #3. */
function stripParity(src: string): { printed: string; edit: string; equal: boolean } {
    const program = parse(src, { ts: true, jsx: false }).program;
    const p = createPrinter({ minify: false });
    printModule(p, program);
    const printed = finishPrinter(p);
    const edit = emitModule(parse(src, { ts: true, jsx: false }).program, src, { stripTypes: true });
    const a = parse(printed, { ts: false, jsx: false });
    const b = parse(edit, { ts: false, jsx: false });
    const equal = a.errors.length === 0 && b.errors.length === 0 && astEqual(a.program, b.program);
    return { printed, edit, equal };
}

const CASES = [
    // literals & identifiers
    'x;',
    '1; 1.5; 0xff; 1e3; 1n;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal JS template source under test
    '"hi"; \'a\'; `t${x}u${y}v`;',
    'true; false; null; /ab+c/gi;',
    'this; foo.bar; a.b.c;',
    // operators & precedence
    'a + b * c;',
    '(a + b) * c;',
    'a * b + c;',
    'a - (b - c);',
    'a ** b ** c;',
    '(-2) ** 2;',
    'a && b || c;',
    'a ?? (b || c);',
    '(a ?? b) || c;',
    'a === b !== c;',
    '!a; -b; +c; ~d; typeof e; void f; delete g.h;',
    '- -a; + +b; !!c;',
    'a++; b--; ++c; --d;',
    'a = b = c;',
    'a += 1; b **= 2; c ||= d;',
    'a ? b : c ? d : e;',
    'a, b, c;',
    // calls / members / new / chains
    'f(a, b, ...c);',
    'new Foo(1, 2);',
    'new Foo;',
    'a?.b?.(c);',
    'a?.[b];',
    'obj?.a.b?.c;',
    '(1).toString();',
    'a.b.c.d();',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal JS template source under test
    'tag`x${y}z`;',
    // functions / arrows
    'function f(a, b = 1, ...r) { return a + b; }',
    'const g = (x) => x + 1;',
    'const h = x => ({ y: x });',
    'const k = async (a) => { await a; };',
    'function* gen() { yield 1; yield* g; }',
    // objects / arrays / patterns
    'const o = { a: 1, b, [c]: 2, ...d };',
    'const o2 = { get x() { return 1; }, set x(v) {} };',
    'const [a, , b, ...c] = arr;',
    'const { x, y: z, w = 1 } = obj;',
    '[1, 2, , 4];',
    // control flow
    'if (a) b(); else c();',
    'for (let i = 0; i < n; i++) work(i);',
    'for (const k in obj) use(k);',
    'for (const v of list) use(v);',
    'while (a) a--;',
    'do x(); while (y);',
    'switch (n) { case 1: a(); break; default: b(); }',
    'try { risky(); } catch (e) { handle(e); } finally { cleanup(); }',
    'outer: for (;;) { break outer; }',
    // statement-start hazards
    '({ a: 1 });',
    '(function () {})();',
    'a; ;;',
    // classes
    'class C {}',
    'class C extends B { constructor() { super(); } m(a) { return a; } }',
    'class C { static s = 1; #p = 2; get x() { return this.#p; } set x(v) {} static { init(); } }',
    'class C { async *gen() {} static async m() {} ["computed"]() {} }',
    'const K = class extends B {};',
    // imports / exports
    "import './side-effect.js';",
    "import def from 'm';",
    "import def, { a, b as c } from 'm';",
    "import * as ns from 'm';",
    "import def, * as ns from 'm';",
    'export { a, b as c };',
    "export { a, b as c } from 'm';",
    'export const x = 1;',
    'export function f() {}',
    'export class C {}',
    'export default function () {}',
    'export default 42;',
    "export * from 'm';",
    "export * as ns from 'm';",
];

/** TS source (stripped) — compared against the edit engine, not round-tripped as-is. */
const TS_CASES = [
    'const x: number = 1;',
    'let y: string | null = null;',
    'function f(a: number, b?: string): void {}',
    'const g = (x: T): U => x as U;',
    'const h = (x!).y;',
    'const v = obj!.prop!.deep;',
    'const a = x satisfies Foo;',
    'interface I { a: number; b(): void; }',
    'type T = { a: number } | string;',
    'class C<T> extends B<number> implements I { x: number = 1; m(a: string): void {} }',
    'const arr: Array<number> = [1, 2, 3];',
    'const fn = foo<number>;',
];

describe('printer — structural round-trip parity', () => {
    for (const src of CASES) {
        it(`non-minify: ${src}`, () => {
            const { printed, equal } = roundTrip(src, false);
            expect(equal, `printed: ${printed}`).toBe(true);
        });
        it(`minify: ${src}`, () => {
            const { printed, equal } = roundTrip(src, true);
            expect(equal, `printed: ${printed}`).toBe(true);
        });
    }
});

describe('printer — TS strip parity vs edit engine', () => {
    for (const src of TS_CASES) {
        it(src, () => {
            const { printed, edit, equal } = stripParity(src);
            expect(equal, `printed: ${printed}\n   edit: ${edit}`).toBe(true);
        });
    }
});

/** Identity JSX runtime: names pass through, no renames — so the printer's native lowering
 *  and the edit engine's `lowerJSX` produce comparable output. */
const JSX_STUB: JSXLower = { runtimeName: (k) => k, renameIdent: () => null };

/** JSX parity: the printer's native `jsx()` lowering must be structurally identical to the
 *  proven edit-engine `lowerJSX`, both re-parsed as plain JS. */
function jsxParity(src: string): { printed: string; edit: string; equal: boolean } {
    const program = parse(src, { ts: true, jsx: true }).program;
    const p = createPrinter({ minify: false }, { jsx: JSX_STUB });
    printModule(p, program);
    const printed = finishPrinter(p);
    const edits = collectStripEdits(parse(src, { ts: true, jsx: true }).program, src, false, null, JSX_STUB);
    const edit = applyEdits(src, edits);
    const a = parse(printed, { ts: false, jsx: false });
    const b = parse(edit, { ts: false, jsx: false });
    const equal = a.errors.length === 0 && b.errors.length === 0 && astEqual(a.program, b.program);
    return { printed, edit, equal };
}

const JSX_CASES = [
    'const a = <div />;',
    'const b = <div className="x" id="y">hi</div>;',
    'const c = <Comp a={1} b="two" flag>text</Comp>;',
    'const d = <><a /><b /></>;',
    'const e = <div>{items.map((x) => <Item key={x.id} value={x} />)}</div>;',
    'const f = <a.b.C prop={1} />;',
    'const g = <input disabled value={v} />;',
    'const h = <p>a &amp; b &lt; c</p>;',
    'const i = <Comp {...props} key={k}>{child}</Comp>;',
    'const j = <ul>{a}{b}{c}</ul>;',
    'const k = <div style={{ color: "red" }}>{cond ? <A /> : <B />}</div>;',
];

describe('printer — JSX parity vs edit engine', () => {
    for (const src of JSX_CASES) {
        it(src, () => {
            const { printed, edit, equal } = jsxParity(src);
            expect(equal, `printed: ${printed}\n   edit: ${edit}`).toBe(true);
        });
    }
});

const minified = (src: string): string => {
    const p = createPrinter({ minify: true });
    printModule(p, parse(src, { ts: false, jsx: false }).program);
    return finishPrinter(p);
};

describe('printer — Phase 2 syntactic minification', () => {
    it('drops parens around a single bare arrow param', () => {
        expect(minified('const f = (x) => x + 1;')).toContain('x=>x+1');
        // …but keeps them when not a bare identifier
        expect(minified('const f = (x = 1) => x;')).toContain('(x=1)=>');
        expect(minified('const f = ({ x }) => x;')).toContain('({x})=>');
        expect(minified('const f = (a, b) => a;')).toContain('(a,b)=>');
        expect(minified('const f = (...r) => r;')).toContain('(...r)=>');
    });

    it('unquotes string property keys that are valid identifiers', () => {
        expect(minified('const o = { "foo": 1, "bar-baz": 2 };')).toContain('{foo:1,"bar-baz":2}');
        expect(minified('class C { "m"() {} }')).toContain('m(){}');
    });

    it('drops the redundant trailing semicolon before } and EOF', () => {
        expect(minified('function f() { a(); b(); }')).toContain('{a();b()}');
        expect(minified('a(); b();')).toBe('a();b()');
        expect(minified('switch (x) { case 1: a(); }')).toContain('case 1:a()}');
    });

    it('is meaningfully smaller than non-minified', () => {
        const src = 'export const compute = (input) => {\n    const result = { "key": input * 2 };\n    return result;\n};';
        const plain = createPrinter({ minify: false });
        printModule(plain, parse(src, { ts: false, jsx: false }).program);
        expect(minified(src).length).toBeLessThan(finishPrinter(plain).length);
    });
});

describe('printer — structural round-trip parity', () => {
    for (const src of CASES) {
        it(`non-minify: ${src}`, () => {
            const { printed, equal } = roundTrip(src, false);
            expect(equal, `printed: ${printed}`).toBe(true);
        });
        it(`minify: ${src}`, () => {
            const { printed, equal } = roundTrip(src, true);
            expect(equal, `printed: ${printed}`).toBe(true);
        });
    }
});
