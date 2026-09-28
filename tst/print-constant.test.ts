import { describe, expect, it } from 'vitest';
import type { ConstantValue } from '../src/analysis/constant-value.ts';
import { N, type Node, node, walk } from '../src/ast/index.ts';
import { parse } from '../src/ast.ts';
import { finalizeStatements } from '../src/bundler/generate/finalize.ts';
import { constantText, numberLiteral, quoteString } from '../src/print/print-constant.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

const num = (value: number): ConstantValue => ({ kind: 'number', value });
const str = (value: string): ConstantValue => ({ kind: 'string', value });

/** Print `src` with every read of a name in `values` substituted by the module finalizer, as rolldown's `inlineConst` would. */
function printWith(src: string, values: Record<string, ConstantValue>, minify: boolean): string {
    const { program } = parse(src, { ts: false, jsx: false });
    const constants = new Map<Node, ConstantValue>();
    walk(program, (n) => {
        if (n.type === N.IdentifierReference && Object.hasOwn(values, n.name)) constants.set(n, values[n.name]);
    });
    const body = finalizeStatements((program.data as { body: Node[] }).body, {
        nameOf: (n) => n.name,
        live: null,
        initCalls: new Map(),
        overrides: new Map(),
        constants,
        defaultName: () => '_default',
        keepNames: false,
        offset: 0,
    });
    const p = createPrinter({ minify });
    printModule(p, node(N.Program, program.start, program.end, '', { body, scopeId: 0 }));
    return finishPrinter(p);
}

/** Print `src` as a module, unchanged. */
function printSource(src: string, minify: boolean): string {
    const { program } = parse(src, { ts: false, jsx: false });
    const p = createPrinter({ minify });
    printModule(p, program);
    return finishPrinter(p);
}

describe('numberLiteral (oxc_ecmascript number_literal)', () => {
    it('matches oxc_ecmascript shortest_number_literal', () => {
        expect(numberLiteral(0)).toBe('0');
        expect(numberLiteral(0.05)).toBe('.05');
        expect(numberLiteral(0.000_001)).toBe('1e-6');
        expect(numberLiteral(1000)).toBe('1e3');
        expect(numberLiteral(281_474_976_710_655)).toBe('0xffffffffffff');
        expect(numberLiteral(1.2e101)).toBe('12e100');
        expect(numberLiteral(Number.MAX_VALUE)).toBe('17976931348623157e292');
    });

    // oxc_codegen tests/integration/esbuild.rs `test_number`, minify expectations.
    it.each([
        [1e-100, '1e-100'],
        [1e-5, '1e-5'],
        [1e-4, '1e-4'],
        [1e-3, '.001'],
        [1e-2, '.01'],
        [1e-1, '.1'],
        [1, '1'],
        [1e1, '10'],
        [1e2, '100'],
        [1e3, '1e3'],
        [1e4, '1e4'],
        [1e100, '1e100'],
        [12e-100, '1.2e-99'],
        [12e-6, '12e-6'],
        [12e-5, '12e-5'],
        [12e-4, '.0012'],
        [12e-3, '.012'],
        [12e-2, '.12'],
        [12e-1, '1.2'],
        [12, '12'],
        [12e1, '120'],
        [12e2, '1200'],
        [12e3, '12e3'],
        [12e4, '12e4'],
        [12e100, '12e100'],
        [0x7fff_ffff, '2147483647'],
        [0x8000_0000, '2147483648'],
        [0x8000_0001, '2147483649'],
        [0xffff_ffff, '4294967295'],
        [0x1_0000_0000, '4294967296'],
        [0x1_0000_0001, '4294967297'],
        // esbuild writes 0x7fff_ffff_ffff_fdff and 0xffff_ffff_ffff_fbff, which round to these.
        [0x7fff_ffff_ffff_fc00, '0x7ffffffffffffc00'],
        [0x8000_0000_0000_0000, '0x8000000000000000'],
        [0x8000_0000_0000_3000, '0x8000000000003000'],
        [0xffff_ffff_ffff_f800, '0xfffffffffffff800'],
        [0x1_0000_0000_0000_0000, '0x10000000000000000'],
        [0x1_0000_0000_0000_1000, '0x10000000000001000'],
    ])('%d -> %s', (value, expected) => {
        expect(numberLiteral(value)).toBe(expected);
    });
});

describe('quoteString (oxc_codegen str.rs)', () => {
    // esbuild.rs `test_string`, by value: non-minify always uses `"`.
    it.each([
        ['', '""'],
        ['\b', '"\\b"'],
        ['\f', '"\\f"'],
        ['\t', '"\t"'],
        ['\v', '"\\v"'],
        ['\n', '"\\n"'],
        ['\r\n', '"\\r\\n"'],
        ["'", `"'"`],
        ['"', '"\\""'],
        ['`', '"`"'],
        ['\\', '"\\\\"'],
        ['\x00', '"\\0"'],
        ['\x00!', '"\\0!"'],
        ['\x001', '"\\x001"'],
        ['\x07', '"\\x07"'],
        ['\x071', '"\\x071"'],
        ['\x01', '"\x01"'],
        ['\x10', '"\x10"'],
        ['\x1B', '"\\x1B"'],
        ['\u{ABCD}', '"\u{ABCD}"'],
        ['\u{123AB}', '"\u{123AB}"'],
        ['\uD808', '"\\ud808"'],
        ['\uD808X', '"\\ud808X"'],
        ['\uDFABX', '"\\udfabX"'],
        ['\uD801\uDC02\uDC03\uD804', '"\u{10402}\\udc03\\ud804"'],
        ['\u2028\u2029\u00A0', '"\\u2028\\u2029\\xA0"'],
        ['</script>', '"<\\/script>"'],
        ['</SCRIPT', '"<\\/SCRIPT"'],
        ['</scrip', '"</scrip"'],
        ['${}', '"${}"'],
    ])('%j', (value, expected) => {
        expect(quoteString(value, false, true)).toBe(expected);
    });

    // js.rs `string`, minify expectations.
    it.each([
        ['${}', '"${}"'],
        ['""${}', `'""\${}'`],
        [`""''\${}`, '`""\'\'\\${}`'],
        [`'''"""\${}`, '`\'\'\'"""\\${}`'],
        ['\uFFFD\uFFFD', '`\uFFFD\uFFFD`'],
        ['\uD800 \uDBFF \uDC00 \uDFFF', '`\\ud800 \\udbff \\udc00 \\udfff`'],
        ['\uD800A', '`\\ud800A`'],
        [`eval("'\vstr\ving\v'") === "\vstr\ving\v"`, '`eval("\'\\vstr\\ving\\v\'") === "\\vstr\\ving\\v"`'],
        ['\n', '`\n`'],
        ['not-exports', '`not-exports`'],
    ])('minify %j', (value, expected) => {
        expect(quoteString(value, true, true)).toBe(expected);
    });

    it('never picks a backtick where one is not allowed', () => {
        expect(quoteString('default', true, false)).toBe('"default"');
        expect(quoteString(`a"b`, true, false)).toBe(`'a"b'`);
        expect(quoteString(`a"'b`, true, false)).toBe(`"a\\"'b"`);
    });
});

// Expectations are rolldown 1.2.4's output for `export const A = <value>` imported and read at each spot,
// with `inlineConst: { mode: 'all' }`.
const USE =
    'console.log(x ** A, A ** x, -A, +A, typeof A, void A, a - A, a + A, A(), A.toString(), A?.x, A[0], new A, { A }, a / A, A / a, `${A}`, !A, k === A, A in a);';

describe('printer substitution', () => {
    it.each<[string, ConstantValue, string, string]>([
        [
            '-1',
            num(-1),
            'console.log(x ** -1, (-1) ** x, - -1, +-1, typeof -1, void -1, a - -1, a + -1, (-1)(), (-1).toString(), (-1)?.x, (-1)[0], new (-1)(), { A: -1 }, a / -1, -1 / a, `${-1}`, !-1, k === -1, -1 in a);',
            'console.log(x**-1,(-1)**x,- -1,+-1,typeof-1,void-1,a- -1,a+-1,(-1)(),(-1).toString(),(-1)?.x,(-1)[0],new(-1),{A:-1},a/-1,-1/a,`${-1}`,!-1,k===-1,-1 in a)',
        ],
        [
            '1',
            num(1),
            'console.log(x ** 1, 1 ** x, -1, +1, typeof 1, void 1, a - 1, a + 1, 1(), 1 .toString(), 1?.x, 1[0], new 1(), { A: 1 }, a / 1, 1 / a, `${1}`, !1, k === 1, 1 in a);',
            'console.log(x**1,1**x,-1,+1,typeof 1,void 1,a-1,a+1,1(),1 .toString(),1?.x,1[0],new 1,{A:1},a/1,1/a,`${1}`,!1,k===1,1 in a)',
        ],
        [
            '-0',
            num(-0),
            'console.log(x ** -0, (-0) ** x, - -0, +-0, typeof -0, void -0, a - -0, a + -0, (-0)(), (-0).toString(), (-0)?.x, (-0)[0], new (-0)(), { A: -0 }, a / -0, -0 / a, `${-0}`, !-0, k === -0, -0 in a);',
            'console.log(x**-0,(-0)**x,- -0,+-0,typeof-0,void-0,a- -0,a+-0,(-0)(),(-0).toString(),(-0)?.x,(-0)[0],new(-0),{A:-0},a/-0,-0/a,`${-0}`,!-0,k===-0,-0 in a)',
        ],
        [
            '1000',
            num(1000),
            'console.log(x ** 1e3, 1e3 ** x, -1e3, +1e3, typeof 1e3, void 1e3, a - 1e3, a + 1e3, 1e3(), 1e3.toString(), 1e3?.x, 1e3[0], new 1e3(), { A: 1e3 }, a / 1e3, 1e3 / a, `${1e3}`, !1e3, k === 1e3, 1e3 in a);',
            'console.log(x**1e3,1e3**x,-1e3,+1e3,typeof 1e3,void 1e3,a-1e3,a+1e3,1e3(),1e3.toString(),1e3?.x,1e3[0],new 1e3,{A:1e3},a/1e3,1e3/a,`${1e3}`,!1e3,k===1e3,1e3 in a)',
        ],
        [
            '0.001',
            num(0.001),
            'console.log(x ** .001, .001 ** x, -.001, +.001, typeof .001, void .001, a - .001, a + .001, .001(), .001.toString(), .001?.x, .001[0], new .001(), { A: .001 }, a / .001, .001 / a, `${.001}`, !.001, k === .001, .001 in a);',
            'console.log(x**.001,.001**x,-.001,+.001,typeof .001,void .001,a-.001,a+.001,.001(),.001.toString(),.001?.x,.001[0],new .001,{A:.001},a/.001,.001/a,`${.001}`,!.001,k===.001,.001 in a)',
        ],
        [
            'NaN',
            num(Number.NaN),
            'console.log(x ** NaN, NaN ** x, -NaN, +NaN, typeof NaN, void NaN, a - NaN, a + NaN, NaN(), NaN.toString(), NaN?.x, NaN[0], new NaN(), { A: NaN }, a / NaN, NaN / a, `${NaN}`, !NaN, k === NaN, NaN in a);',
            'console.log(x**NaN,NaN**x,-NaN,+NaN,typeof NaN,void NaN,a-NaN,a+NaN,NaN(),NaN.toString(),NaN?.x,NaN[0],new NaN,{A:NaN},a/NaN,NaN/a,`${NaN}`,!NaN,k===NaN,NaN in a)',
        ],
        [
            '10n',
            { kind: 'bigint', value: 10n },
            'console.log(x ** 10n, 10n ** x, -10n, +10n, typeof 10n, void 10n, a - 10n, a + 10n, 10n(), 10n.toString(), 10n?.x, 10n[0], new 10n(), { A: 10n }, a / 10n, 10n / a, `${10n}`, !10n, k === 10n, 10n in a);',
            'console.log(x**10n,10n**x,-10n,+10n,typeof 10n,void 10n,a-10n,a+10n,10n(),10n.toString(),10n?.x,10n[0],new 10n,{A:10n},a/10n,10n/a,`${10n}`,!10n,k===10n,10n in a)',
        ],
        [
            'void 0',
            { kind: 'undefined' },
            'console.log(x ** void 0, (void 0) ** x, -void 0, +void 0, typeof void 0, void void 0, a - void 0, a + void 0, (void 0)(), (void 0).toString(), (void 0)?.x, (void 0)[0], new (void 0)(), { A: void 0 }, a / void 0, void 0 / a, `${void 0}`, !void 0, k === void 0, void 0 in a);',
            'console.log(x**void 0,(void 0)**x,-void 0,+void 0,typeof void 0,void void 0,a-void 0,a+void 0,(void 0)(),(void 0).toString(),(void 0)?.x,(void 0)[0],new(void 0),{A:void 0},a/void 0,void 0/a,`${void 0}`,!void 0,k===void 0,void 0 in a)',
        ],
        [
            'null',
            { kind: 'null' },
            'console.log(x ** null, null ** x, -null, +null, typeof null, void null, a - null, a + null, null(), null.toString(), null?.x, null[0], new null(), { A: null }, a / null, null / a, `${null}`, !null, k === null, null in a);',
            'console.log(x**null,null**x,-null,+null,typeof null,void null,a-null,a+null,null(),null.toString(),null?.x,null[0],new null,{A:null},a/null,null/a,`${null}`,!null,k===null,null in a)',
        ],
        [
            'true',
            { kind: 'boolean', value: true },
            'console.log(x ** true, true ** x, -true, +true, typeof true, void true, a - true, a + true, true(), true.toString(), true?.x, true[0], new true(), { A: true }, a / true, true / a, `${true}`, !true, k === true, true in a);',
            'console.log(x**true,true**x,-true,+true,typeof true,void true,a-true,a+true,true(),true.toString(),true?.x,true[0],new true,{A:true},a/true,true/a,`${true}`,!true,k===true,true in a)',
        ],
        [
            '"a"',
            str('a'),
            'console.log(x ** "a", "a" ** x, -"a", +"a", typeof "a", void "a", a - "a", a + "a", "a"(), "a".toString(), "a"?.x, "a"[0], new "a"(), { A: "a" }, a / "a", "a" / a, `${"a"}`, !"a", k === "a", "a" in a);',
            'console.log(x**`a`,`a`**x,-`a`,+`a`,typeof`a`,void`a`,a-`a`,a+`a`,`a`(),`a`.toString(),`a`?.x,`a`[0],new`a`,{A:`a`},a/`a`,`a`/a,`${`a`}`,!`a`,k===`a`,`a`in a)',
        ],
        [
            '"default"',
            str('default'),
            'console.log(x ** "default", "default" ** x, -"default", +"default", typeof "default", void "default", a - "default", a + "default", "default"(), "default".toString(), "default"?.x, "default"[0], new "default"(), { A: "default" }, a / "default", "default" / a, `${"default"}`, !"default", k === "default", "default" in a);',
            'console.log(x**`default`,`default`**x,-`default`,+`default`,typeof`default`,void`default`,a-`default`,a+`default`,`default`(),`default`.toString(),`default`?.x,`default`[0],new`default`,{A:`default`},a/`default`,`default`/a,`${`default`}`,!`default`,k==="default",`default`in a)',
        ],
        [
            '"${x}"',
            str('${x}'),
            'console.log(x ** "${x}", "${x}" ** x, -"${x}", +"${x}", typeof "${x}", void "${x}", a - "${x}", a + "${x}", "${x}"(), "${x}".toString(), "${x}"?.x, "${x}"[0], new "${x}"(), { A: "${x}" }, a / "${x}", "${x}" / a, `${"${x}"}`, !"${x}", k === "${x}", "${x}" in a);',
            'console.log(x**"${x}","${x}"**x,-"${x}",+"${x}",typeof"${x}",void"${x}",a-"${x}",a+"${x}","${x}"(),"${x}".toString(),"${x}"?.x,"${x}"[0],new"${x}",{A:"${x}"},a/"${x}","${x}"/a,`${"${x}"}`,!"${x}",k==="${x}","${x}"in a)',
        ],
    ])('%s', (_label, value, readable, minified) => {
        expect(printWith(USE, { A: value }, false)).toBe(readable);
        expect(printWith(USE, { A: value }, true)).toBe(minified);
    });

    // rolldown with compress on (the only way a literal Infinity reaches oxc's minifying codegen).
    it('prints Infinity as a wrapped 1/0 under minify', () => {
        const src = 'console.log(x ** A, A ** x, a / A, -A, A(), { A }, k === A, B ** x, a / B);';
        expect(printWith(src, { A: num(Infinity), B: num(-Infinity) }, true)).toBe(
            'console.log(x**(1/0),(1/0)**x,a/(1/0),-(1/0),(1/0)(),{A:1/0},k===1/0,(-1/0)**x,a/(-1/0))',
        );
        expect(printWith(src, { A: num(Infinity), B: num(-Infinity) }, false)).toBe(
            'console.log(x ** Infinity, Infinity ** x, a / Infinity, -Infinity, Infinity(), { A: Infinity }, k === Infinity, (-Infinity) ** x, a / -Infinity);',
        );
    });

    it('keeps `delete Infinity` legal outside minify', () => {
        expect(printWith('delete A;', { A: num(Infinity) }, false)).toBe('delete (0, Infinity);');
        expect(printWith('delete A;', { A: num(Infinity) }, true)).toBe('delete(1/0)');
    });

    it('separates a negative BigInt from a preceding minus, which oxc does not', () => {
        expect(printWith('x = -A, a - A, A ** x;', { A: { kind: 'bigint', value: -5n } }, true)).toBe('x=- -5n,a- -5n,(-5n)**x');
    });

    it('spaces a number after a keyword even when it starts with a dot', () => {
        const src = 'function f() { return A; } switch (x) { case A: }';
        expect(printWith(src, { A: num(0.5) }, true)).toBe('function f(){return .5}switch(x){case .5:}');
        expect(printWith(src, { A: str('x') }, true)).toBe('function f(){return`x`}switch(x){case`x`:}');
        expect(printSource('export default .5;', true)).toBe('export default .5');
        expect(printSource('export default "x";', true)).toBe('export default`x`');
    });

    it('keeps plain strings where cjs-module-lexer pattern-matches them', () => {
        const src =
            'require(A); Object.defineProperty(exports, A, {}); exports[A] = 1; module.exports[A] = 1; k == A; A !== k; f(A);';
        expect(printWith(src, { A: str('x') }, true)).toBe(
            'require("x");Object.defineProperty(exports,"x",{});exports["x"]=1;module.exports["x"]=1;k==`x`;`x`!==k;f(`x`)',
        );
        expect(printWith('k === A; A == k;', { A: str('__esModule') }, true)).toBe('k==="__esModule";"__esModule"==k');
    });

    it('expands a shorthand property and leaves the key alone', () => {
        expect(printWith('x = { A, b };', { A: num(-1) }, false)).toBe('x = { A: -1, b };');
        expect(printWith('x = { A, b };', { A: num(-1) }, true)).toBe('x={A:-1,b}');
    });

    it('leaves an unmapped read alone', () => {
        expect(printWith('x = A + B;', { A: num(1) }, true)).toBe('x=1+B');
    });
});

describe('constantText', () => {
    it.each<[ConstantValue, string, string]>([
        [num(-1), '-1', '-1'],
        [num(1000), '1e3', '1e3'],
        [num(-0), '-0', '-0'],
        [num(Number.NaN), 'NaN', 'NaN'],
        [num(Infinity), 'Infinity', '1/0'],
        [num(-Infinity), '-Infinity', '-1/0'],
        [{ kind: 'bigint', value: -5n }, '-5n', '-5n'],
        [str("it's"), `"it's"`, "`it's`"],
        [{ kind: 'boolean', value: false }, 'false', 'false'],
        [{ kind: 'null' }, 'null', 'null'],
        [{ kind: 'undefined' }, 'void 0', 'void 0'],
    ])('%#: %s', (value, readable, minified) => {
        expect(constantText(value, false)).toBe(readable);
        expect(constantText(value, true)).toBe(minified);
    });
});
