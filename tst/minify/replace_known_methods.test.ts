// Port of oxc_minifier/tests/peephole/replace_known_methods.rs.
import { describe, it } from 'vitest';
import type { CompressTargets } from '../../src/passes/minifier/options.ts';
import { defaultOptions, esTargets, testOptions } from './harness.ts';

/** oxc `EngineTargets::default()`, which `default_options()` uses: no engines, so `has_feature` is
 *  false and the strict `supports_es_feature` is false too. */
const ANY_TARGETS: CompressTargets = { hasFeature: () => false, supportsEsFeature: () => false };

const test = (source: string, expected: string): void =>
    testOptions(source, expected, { ...defaultOptions(), target: ANY_TARGETS });

const testSame = (source: string): void => test(source, source);

const testValue = (code: string, expected: string): void => test(`x = ${code}`, `x = ${expected}`);

const testSameValue = (code: string): void => testSame(`x = ${code}`);

const foldStringTyped = (js: string, expected: string): void =>
    test(`function f(/** string */ a) {${js}}`, `function f(/** string */ a) {${expected}}`);

const testSameStringTyped = (js: string): void => foldStringTyped(js, js);

/** Chrome's first supporting version (oxc_compat es_features.rs) for the features these cases reach.
 *  Features not listed count as supported through ES2015 and unsupported after. */
const CHROME_FEATURE_VERSIONS: Record<string, number> = {
    ES2015TemplateLiterals: 62,
    ES2015StickyRegex: 49,
    ES2015UnicodeRegex: 50,
    ES2016ExponentiationOperator: 52,
};

const featureYear = (feature: string): number => Number(/^ES(\d{4})/.exec(feature)?.[1] ?? 0);

function chromeTargets(version: number): CompressTargets {
    const supports = (feature: string): boolean => {
        const since = CHROME_FEATURE_VERSIONS[feature];
        return since === undefined ? featureYear(feature) <= 2015 : version >= since;
    };
    return { hasFeature: (feature) => !supports(feature), supportsEsFeature: supports };
}

/** oxc `test_target` with a target string (`esNNNN` or `chromeNN`). */
function testTargetNamed(source: string, expected: string, target: string): void {
    const es = /^es(\d{4})$/.exec(target);
    const chrome = /^chrome(\d+)$/.exec(target);
    const targets = es !== null ? esTargets(Number(es[1])) : chrome !== null ? chromeTargets(Number(chrome[1])) : null;
    if (targets === null) throw new Error(`unknown target ${target}`);
    testOptions(source, expected, { ...defaultOptions(), target: targets });
}

describe('replace_known_methods', () => {
    it('test_string_index_of', () => {
        test("x = 'abcdef'.indexOf('g')", 'x = -1');
        test("x = 'abcdef'.indexOf('b')", 'x = 1');
        test("x = 'abcdefbe'.indexOf('b', 2)", 'x = 6');
        test("x = 'abcdef'.indexOf('bcd')", 'x = 1');
        test("x = 'abcdefsdfasdfbcdassd'.indexOf('bcd', 4)", 'x = 13');
        testSame("x = 'abcdef'.indexOf(...a, 1)");
        testSame("x = 'abcdef'.indexOf('b', ...a)");
        testSame("x = 'abcdef'.indexOf(a, 1)");
        testSame("x = 'abcdef'.indexOf('b', a)");

        test("x = 'abcdef'.lastIndexOf('b')", 'x = 1');
        test("x = 'abcdefbe'.lastIndexOf('b')", 'x = 6');
        test("x = 'abcdefbe'.lastIndexOf('b', 5)", 'x = 1');

        test("x = 'abc1def'.indexOf(1)", 'x = 3');
        test("x = 'abcNaNdef'.indexOf(NaN)", 'x = 3');
        test("x = 'abcundefineddef'.indexOf(undefined)", 'x = 3');
        test("x = 'abcnulldef'.indexOf(null)", 'x = 3');
        test("x = 'abctruedef'.indexOf(true)", 'x = 3');

        testSame("x = 1 .indexOf('bcd');");
        testSame("x = NaN.indexOf('bcd')");
        test("x = undefined.indexOf('bcd')", "x = (void 0).indexOf('bcd')");
        testSame("x = null.indexOf('bcd')");
        testSame("x = (!0).indexOf('bcd')");
        testSame("x = (!1).indexOf('bcd')");

        // dealing with regex or other types.
        test("x = 'abcdef/b./'.indexOf(/b./)", 'x = 6');
        test("x = 'abcdef[object Object]'.indexOf({a:2})", 'x = 6');
        test("x = 'abcdef1,2'.indexOf([1,2])", 'x = 6');

        // Template Strings
        testSame("x = `Hello ${name}`.indexOf('a')");
        testSame("x = tag `Hello ${name}`.indexOf('a')");
    });

    it.skip('test_string_index_of: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test("x = `abcdef`.indexOf('b')", 'x = 1');
    });

    it.skip('test_string_join_add_sparse: ignored in oxc, TODO: Array.join optimization with sparse arrays not yet implemented', () => {
        test("x = [,,'a'].join(',')", "x = ',,a'");
    });

    it.skip('test_no_string_join: ignored in oxc, TODO: Array.join optimization edge cases not yet implemented', () => {
        testSame("x = [].join(',',2)");
        testSame('x = [].join(f)');
    });

    it.skip('test_string_join_add: ignored in oxc, TODO: Array.join to string concatenation optimization not yet implemented', () => {
        test("x = ['a', 'b', 'c'].join('')", 'x = "abc"');
        test("x = [].join(',')", 'x = ""');
        test("x = ['a'].join(',')", 'x = "a"');
        test("x = ['a', 'b', 'c'].join(',')", 'x = "a,b,c"');
        test("x = ['a', foo, 'b', 'c'].join(',')", 'x = ["a",foo,"b,c"].join()');
        test("x = [foo, 'a', 'b', 'c'].join(',')", 'x = [foo,"a,b,c"].join()');
        test("x = ['a', 'b', 'c', foo].join(',')", 'x = ["a,b,c",foo].join()');

        // Works with numbers
        test("x = ['a=', 5].join('')", 'x = "a=5"');
        test("x = ['a', '5'].join(7)", 'x = "a75"');

        // Works on boolean
        test("x = ['a=', false].join('')", 'x = "a=false"');
        test("x = ['a', '5'].join(true)", 'x = "atrue5"');
        test("x = ['a', '5'].join(false)", 'x = "afalse5"');

        // Only optimize if it's a size win.
        test("x = ['a', '5', 'c'].join('a very very very long chain')", 'x = ["a","5","c"].join("a very very very long chain")');

        // Template strings
        test('x = [`a`, `b`, `c`].join(``)', "x = 'abc'");
        test("x = [`a`, `b`, `c`].join('')", "x = 'abc'");

        // TODO(user): Its possible to fold this better.
        testSame("x = ['', foo].join('-')");
        testSame("x = ['', foo, ''].join()");

        test(
            "x = ['', '', foo, ''].join(',')", //
            "x = [ ','  , foo, ''].join()",
        );
        test(
            "x = ['', '', foo, '', ''].join(',')", //
            "x = [ ',',   foo,  ','].join()",
        );

        test(
            "x = ['', '', foo, '', '', bar].join(',')", //
            "x = [ ',',   foo,  ',',   bar].join()",
        );

        test(
            "x = [1,2,3].join('abcdef')", //
            "x = '1abcdef2abcdef3'",
        );

        test('x = [1,2].join()', "x = '1,2'");
        test("x = [null,undefined,''].join(',')", "x = ',,'");
        test("x = [null,undefined,0].join(',')", "x = ',,0'");
        // This can be folded but we don't currently.
        testSame('x = [[1,2],[3,4]].join()'); // would like: "x = '1,2,3,4'"
    });

    it.skip('test_string_join_add_b1992789: ignored in oxc, TODO: Array.join single element optimization not yet implemented', () => {
        test("x = ['a'].join('')", 'x = "a"');
        testSame("x = [foo()].join('')");
        testSame("[foo()].join('')");
        test("[null].join('')", "''");
    });

    it('test_fold_string_replace', () => {
        test("x = 'c'.replace('c','x')", "x = 'x'");
        test("x = 'ac'.replace('c','x')", "x = 'ax'");
        test("x = 'ca'.replace('c','x')", "x = 'xa'");
        test("x = 'ac'.replace('c','xxx')", "x = 'axxx'");
        test("x = 'ca'.replace('c','xxx')", "x = 'xxxa'");
        testSame("x = 'c'.replace((foo(), 'c'), 'b')");

        testSame("x = '[object Object]'.replace({}, 'x')"); // can be folded to "x"
        testSame("x = 'a'.replace({ [Symbol.replace]() { return 'x' } }, 'c')"); // can be folded to "x"

        // only one instance replaced
        test("x = 'acaca'.replace('c','x')", "x = 'axaca'");
        test("x = 'ab'.replace('','x')", "x = 'xab'");

        testSame("'acaca'.replace(/c/,'x')"); // this will affect the global RegExp props
        testSame("'acaca'.replace(/c/g,'x')"); // this will affect the global RegExp props

        // not a literal
        testSame("x.replace('x','c')");

        testSame("'Xyz'.replace('Xyz', '$$')"); // would fold to '$'
        testSame("'PreXyzPost'.replace('Xyz', '$&')"); // would fold to 'PreXyzPost'
        testSame("'PreXyzPost'.replace('Xyz', '$`')"); // would fold to 'PrePrePost'
        testSame("'PreXyzPost'.replace('Xyz', '$\\'')"); // would fold to  'PrePostPost'
        testSame("'PreXyzPostXyz'.replace('Xyz', '$\\'')"); // would fold to 'PrePostXyzPostXyz'
        testSame("'123'.replace('2', '$`')"); // would fold to '113'
    });

    it('test_fold_string_replace_all', () => {
        test("x = 'abcde'.replaceAll('bcd','c')", "x = 'ace'");
        test("x = 'abcde'.replaceAll('c','xxx')", "x = 'abxxxde'");
        test("x = 'abcde'.replaceAll('xxx','c')", "x = 'abcde'");
        test("x = 'ab'.replaceAll('','x')", "x = 'xaxbx'");

        test("x = 'c_c_c'.replaceAll('c','x')", "x = 'x_x_x'");
        test("x = 'acaca'.replaceAll('c',/x/)", "x = 'a/x/a/x/a'");

        testSame("x = '[object Object]'.replaceAll({}, 'x')"); // can be folded to "x"
        testSame("x = 'a'.replaceAll({ [Symbol.replace]() { return 'x' } }, 'c')"); // can be folded to "x"

        testSame("x = 'acaca'.replaceAll(/c/,'x')"); // this should throw
        testSame("x = 'acaca'.replaceAll(/c/g,'x')"); // this will affect the global RegExp props

        // not a literal
        testSame("x.replaceAll('x','c')");

        testSame("'Xyz'.replaceAll('Xyz', '$$')"); // would fold to '$'
        testSame("'PreXyzPost'.replaceAll('Xyz', '$&')"); // would fold to 'PreXyzPost'
        testSame("'PreXyzPost'.replaceAll('Xyz', '$`')"); // would fold to 'PrePrePost'
        testSame("'PreXyzPost'.replaceAll('Xyz', '$\\'')"); // would fold to  'PrePostPost'
        testSame("'PreXyzPostXyz'.replaceAll('Xyz', '$\\'')"); // would fold to 'PrePostXyzPost'
        testSame("'123'.replaceAll('2', '$`')"); // would fold to '113'
    });

    it('test_fold_string_substring', () => {
        test("x = 'abcde'.substring(0,2)", "x = 'ab'");
        test("x = 'abcde'.substring(1,2)", "x = 'b'");
        test("x = 'abcde'.substring(2)", "x = 'cde'");
        testSame("x = 'abcde'.substring(...a, 1)");
        testSame("x = 'abcde'.substring(1, ...a)");
        testSame("x = 'abcde'.substring(a, 1)");
        testSame("x = 'abcde'.substring(1, a)");

        // we should be leaving negative, out-of-bound, and inverted indices alone for now
        testSame("x = 'abcde'.substring(-1)");
        testSame("x = 'abcde'.substring(1, -2)");
        testSame("x = 'abcde'.substring(1, 2, 3)");
        testSame("x = 'abcde'.substring(2, 0)");
        testSame("x = 'a'.substring(0, 2)");

        // Template strings
        testSame('x = `abcdef ${abc}`.substring(0,2)');
    });

    it.skip('test_fold_string_substring: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `abcdef`.substring(0,2)', "x = 'ab'");
    });

    it('test_fold_string_slice', () => {
        test("x = 'abcde'.slice(0,2)", "x = 'ab'");
        test("x = 'abcde'.slice(1,2)", "x = 'b'");
        test("x = 'abcde'.slice(2)", "x = 'cde'");

        // we should be leaving negative, out-of-bound, and inverted indices alone for now
        testSame("x = 'abcde'.slice(-1)");
        testSame("x = 'abcde'.slice(1, -2)");
        testSame("x = 'abcde'.slice(1, 2, 3)");
        testSame("x = 'abcde'.slice(2, 0)");
        testSame("x = 'a'.slice(0, 2)");

        // Template strings
        testSame('x = `abcdef ${abc}`.slice(0,2)');
    });

    it.skip('test_fold_string_slice: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `abcdef`.slice(0, 2)', "x = 'ab'");
    });

    it('test_fold_string_char_at', () => {
        test("x = 'abcde'.charAt(0)", "x = 'a'");
        test("x = 'abcde'.charAt(1)", "x = 'b'");
        test("x = 'abcde'.charAt(2)", "x = 'c'");
        test("x = 'abcde'.charAt(3)", "x = 'd'");
        test("x = 'abcde'.charAt(4)", "x = 'e'");
        test("x = 'abcde'.charAt(5)", "x = ''");
        test("x = 'abcde'.charAt(-1)", "x = ''");
        test("x = 'abcde'.charAt()", "x = 'a'");
        testSame("x = 'abcde'.charAt(...foo)");
        testSame("x = 'abcde'.charAt(0, ++z)");
        testSame("x = 'abcde'.charAt(y)");
        test("x = 'abcde'.charAt(null)", "x = 'a'");
        test("x = 'abcde'.charAt(!0)", "x = 'b'");
        testSame("x = '\\ud834\\udd1e'.charAt(0)"); // or x = '\\ud834'
        testSame("x = '\\ud834\\udd1e'.charAt(1)"); // or x = '\\udd1e'

        // Template strings
        testSame('x = `abcdef ${abc}`.charAt(0)');
    });

    it.skip('test_fold_string_char_at: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `abcdef`.charAt(0)', "x = 'a'");
    });

    it('test_fold_string_char_code_at', () => {
        test("x = 'abcde'.charCodeAt()", 'x = 97');
        test("x = 'abcde'.charCodeAt(0)", 'x = 97');
        test("x = 'abcde'.charCodeAt(1)", 'x = 98');
        test("x = 'abcde'.charCodeAt(2)", 'x = 99');
        test("x = 'abcde'.charCodeAt(3)", 'x = 100');
        test("x = 'abcde'.charCodeAt(4)", 'x = 101');
        test("x = 'abcde'.charCodeAt(5)", 'x = NaN');
        test("x = 'abcde'.charCodeAt(-1)", 'x = NaN');
        testSame("x = 'abcde'.charCodeAt(...foo)");
        testSame("x = 'abcde'.charCodeAt(y)");
        test("x = 'abcde'.charCodeAt()", 'x = 97');
        testSame("x = 'abcde'.charCodeAt(0, ++z)");
        testSame("x = 'abcde'.charCodeAt(0, f())");
        test("x = 'abcde'.charCodeAt(null)", 'x = 97');
        test("x = 'abcde'.charCodeAt(true)", 'x = 98');
        test("x = '\\ud834\\udd1e'.charCodeAt(0)", 'x = 55348');
        test("x = '\\ud834\\udd1e'.charCodeAt(1)", 'x = 56606');
        testSame('x = `abcdef ${abc}`.charCodeAt(0)');
    });

    it.skip('test_fold_string_char_code_at: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `abcdef`.charCodeAt(0)', 'x = 97');
    });

    it.skip('test_fold_string_split: ignored in oxc, TODO: String.split optimization not yet implemented', () => {
        // late = false;
        test("x = 'abcde'.split('foo')", "x = ['abcde']");
        test("x = 'abcde'.split()", "x = ['abcde']");
        test("x = 'abcde'.split(null)", "x = ['abcde']");
        test("x = 'a b c d e'.split(' ')", "x = ['a','b','c','d','e']");
        test("x = 'a b c d e'.split(' ', 0)", 'x = []');
        test("x = 'abcde'.split('cd')", "x = ['ab','e']");
        test("x = 'a b c d e'.split(' ', 1)", "x = ['a']");
        test("x = 'a b c d e'.split(' ', 3)", "x = ['a','b','c']");
        test("x = 'a b c d e'.split(null, 1)", "x = ['a b c d e']");
        test("x = 'aaaaa'.split('a')", "x = ['', '', '', '', '', '']");
        test("x = 'xyx'.split('x')", "x = ['', 'y', '']");

        // Empty separator
        test("x = 'abcde'.split('')", "x = ['a','b','c','d','e']");
        test("x = 'abcde'.split('', 3)", "x = ['a','b','c']");

        // Empty separator AND empty string
        test("x = ''.split('')", 'x = []');

        // Separator equals string
        test("x = 'aaa'.split('aaa')", "x = ['','']");
        test("x = ' '.split(' ')", "x = ['','']");

        testSame("x = 'abcde'.split(/ /)");
        testSame("x = 'abcde'.split(' ', -1)");

        // Template strings
        testSame('x = `abcdef`.split()');
        testSame('x = `abcdef ${abc}`.split()');

        // late = true;
        // testSame("x = 'a b c d e'.split(' ')");
    });

    it.skip('test_join_bug: ignored in oxc, TODO: Array.join edge case optimization not yet implemented', () => {
        test('var x = [].join();', "var x = '';");
        testSame('var x = [x].join();');
        testSame('var x = [x,y].join();');
        testSame('var x = [x,y,z].join();');

        // testSame(
        // lines(
        // "shape['matrix'] = [",
        // "    Number(headingCos2).toFixed(4),",
        // "    Number(-headingSin2).toFixed(4),",
        // "    Number(headingSin2 * yScale).toFixed(4),",
        // "    Number(headingCos2 * yScale).toFixed(4),",
        // "    0,",
        // "    0",
        // "  ].join()"));
    });

    it.skip('test_join_spread1: ignored in oxc, TODO: Array.join with spread syntax optimization not yet implemented', () => {
        testSame("var x = [...foo].join('');");
        testSame("var x = [...someMap.keys()].join('');");
        testSame("var x = [foo, ...bar].join('');");
        testSame("var x = [...foo, bar].join('');");
        testSame("var x = [...foo, 'bar'].join('');");
        testSame("var x = ['1', ...'2', '3'].join('');");
        testSame("var x = ['1', ...['2'], '3'].join('');");
    });

    it.skip('test_join_spread2: ignored in oxc, TODO: Array.join with spread syntax optimization not yet implemented', () => {
        test("var x = [...foo].join(',');", 'var x = [...foo].join();');
        test("var x = [...someMap.keys()].join(',');", 'var x = [...someMap.keys()].join();');
        test("var x = [foo, ...bar].join(',');", 'var x = [foo, ...bar].join();');
        test("var x = [...foo, bar].join(',');", 'var x = [...foo, bar].join();');
        test("var x = [...foo, 'bar'].join(',');", "var x = [...foo, 'bar'].join();");
        test("var x = ['1', ...'2', '3'].join(',');", "var x = ['1', ...'2', '3'].join();");
        test("var x = ['1', ...['2'], '3'].join(',');", "var x = ['1', ...['2'], '3'].join();");
    });

    it('test_to_upper', () => {
        test("x = 'a'.toUpperCase()", "x = 'A'");
        test("x = 'A'.toUpperCase()", "x = 'A'");
        test("x = 'aBcDe'.toUpperCase()", "x = 'ABCDE'");

        testSame('`a ${bc}`.toUpperCase()');

        /*
         * Make sure things aren't totally broken for non-ASCII strings, non-exhaustive.
         *
         * <p>This includes things like:
         *
         * <ul>
         *   <li>graphemes with multiple code-points
         *   <li>graphemes represented by multiple graphemes in other cases
         *   <li>graphemes whose case changes are not round-trippable
         *   <li>graphemes that change case in a position sentitive way
         * </ul>
         */
        test("x = '\u{0049}'.toUpperCase()", "x = '\u{0049}'");
        test("x = '\u{0069}'.toUpperCase()", "x = '\u{0049}'");
        test("x = '\u{0130}'.toUpperCase()", "x = '\u{0130}'");
        test("x = '\u{0131}'.toUpperCase()", "x = '\u{0049}'");
        test("x = '\u{0049}\u{0307}'.toUpperCase()", "x = '\u{0049}\u{0307}'");
        test("x = '\u{df}'.toUpperCase()", "x = 'SS'");
        test("x = 'SS'.toUpperCase()", "x = 'SS'");
        test("x = '\u{3c3}'.toUpperCase()", "x = '\u{3a3}'");
        test("x = '\u{3c3}\u{3c2}'.toUpperCase()", "x = '\u{3a3}\u{3a3}'");
    });

    it.skip('test_to_upper: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `abc`.toUpperCase()', "x = 'ABC'");
    });

    it('test_to_lower', () => {
        test("x = 'A'.toLowerCase()", "x = 'a'");
        test("x = 'a'.toLowerCase()", "x = 'a'");
        test("x = 'aBcDe'.toLowerCase()", "x = 'abcde'");

        testSame('`A ${BC}`.toLowerCase()');

        /*
         * Make sure things aren't totally broken for non-ASCII strings, non-exhaustive.
         *
         * <p>This includes things like:
         *
         * <ul>
         *   <li>graphemes with multiple code-points
         *   <li>graphemes with multiple representations
         *   <li>graphemes represented by multiple graphemes in other cases
         *   <li>graphemes whose case changes are not round-trippable
         *   <li>graphemes that change case in a position sentitive way
         * </ul>
         */
        test("x = '\u{0049}'.toLowerCase()", "x = '\u{0069}'");
        test("x = '\u{0069}'.toLowerCase()", "x = '\u{0069}'");
        test("x = '\u{0130}'.toLowerCase()", "x = '\u{0069}\u{0307}'");
        test("x = '\u{0131}'.toLowerCase()", "x = '\u{0131}'");
        test("x = '\u{0049}\u{0307}'.toLowerCase()", "x = '\u{0069}\u{0307}'");
        test("x = '\u{df}'.toLowerCase()", "x = '\u{df}'");
        test("x = 'SS'.toLowerCase()", "x = 'ss'");
        test("x = '\u{3a3}'.toLowerCase()", "x = '\u{3c3}'");
        test("x = '\u{3a3}\u{3a3}'.toLowerCase()", "x = '\u{3c3}\u{3c2}'");
    });

    it.skip('test_to_lower: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `ABC`.toLowerCase()', "x = 'abc'");
    });

    it('test_fold_string_trim', () => {
        test("x = '  abc  '.trim()", "x = 'abc'");
        test("x = 'abc'.trim()", "x = 'abc'");
        testSame("x = 'abc'.trim(1)");

        test("x = '  abc  '.trimStart()", "x = 'abc  '");
        test("x = 'abc'.trimStart()", "x = 'abc'");
        testSame("x = 'abc'.trimStart(1)");

        test("x = '  abc  '.trimEnd()", "x = '  abc'");
        test("x = 'abc'.trimEnd()", "x = 'abc'");
        testSame("x = 'abc'.trimEnd(1)");
    });

    it('test_fold_math_functions_bug', () => {
        testSame('Math[0]()');
    });

    it('test_fold_math_functions_abs', () => {
        testSameValue('Math.abs(Math.random())');

        testValue("Math.abs('-1')", '1');
        testValue('Math.abs(-2)', '2');
        testValue('Math.abs(null)', '0');
        testValue("Math.abs('')", '0');
        testValue('Math.abs(NaN)', 'NaN');
        testValue('Math.abs(-0)', '0');
        testValue('Math.abs(-Infinity)', 'Infinity');
        testValue('Math.abs([])', '0');
        testValue('Math.abs([2])', '2');
        testValue('Math.abs([1,2])', 'NaN');
        testValue('Math.abs({})', 'NaN');
        testValue("Math.abs('string');", 'NaN');
    });

    it('test_fold_math_functions_imul', () => {
        testSameValue('Math.imul(Math.random(),2)');
        testValue('Math.imul()', '0');
        testValue('Math.imul(-1,1)', '-1');
        testValue('Math.imul(2,2)', '4');
        testValue('Math.imul(2)', '0');
        testValue('Math.imul(2,3,5)', '6');
        testValue('Math.imul(0xfffffffe, 5)', '-10');
        testValue('Math.imul(0xffffffff, 5)', '-5');
        testValue('Math.imul(0xfffffffffffff34f, 0xfffffffffff342)', '13369344');
        testValue('Math.imul(0xfffffffffffff34f, -0xfffffffffff342)', '-13369344');
        testValue('Math.imul(NaN, 2)', '0');
    });

    it('test_fold_math_functions_ceil', () => {
        testSameValue('Math.ceil(Math.random())');

        testValue('Math.ceil(1)', '1');
        testValue('Math.ceil(1.5)', '2');
        testValue('Math.ceil(1.3)', '2');
        testValue('Math.ceil(-1.3)', '-1');
    });

    it('test_fold_math_functions_floor', () => {
        testSameValue('Math.floor(Math.random())');

        testValue('Math.floor(1)', '1');
        testValue('Math.floor(1.5)', '1');
        testValue('Math.floor(1.3)', '1');
        testValue('Math.floor(-1.3)', '-2');
    });

    it('test_fold_math_functions_fround', () => {
        testSameValue('Math.fround(Math.random())');

        testValue('Math.fround(NaN)', 'NaN');
        testValue('Math.fround(Infinity)', 'Infinity');
        testValue('Math.fround(-Infinity)', '-Infinity');
        testValue('Math.fround(1)', '1');
        testValue('Math.fround(0)', '0');
        testValue('Math.fround(16777217)', '16777216');
        testValue('Math.fround(16777218)', '16777218');
    });

    it('test_fold_math_functions_fround_j2cl', () => {
        testSameValue('Math.fround(1.2)');
    });

    it('test_fold_math_functions_round', () => {
        testSameValue('Math.round(Math.random())');
        testValue('Math.round(NaN)', 'NaN');
        testValue('Math.round(3)', '3');
        testValue('Math.round(3.5)', '4');
        testValue('Math.round(-3.5)', '-3');
    });

    it('test_fold_math_functions_sign', () => {
        testSameValue('Math.sign(Math.random())');
        testValue('Math.sign(NaN)', 'NaN');
        testValue('Math.sign(0.0)', '0');
        testValue('Math.sign(-0.0)', '-0');
        testValue('Math.sign(0.01)', '1');
        testValue('Math.sign(-0.01)', '-1');
        testValue('Math.sign(3.5)', '1');
        testValue('Math.sign(-3.5)', '-1');
    });

    it('test_fold_math_functions_trunc', () => {
        testSameValue('Math.trunc(Math.random())');
        testValue('Math.sign(NaN)', 'NaN');
        testValue('Math.trunc(3.5)', '3');
        testValue('Math.trunc(-3.5)', '-3');
        testValue('Math.trunc(0.5)', '0');
        testValue('Math.trunc(-0.5)', '-0');
    });

    it('test_fold_math_functions_clz32', () => {
        testValue('Math.clz32(0)', '32');
        testValue('Math.clz32(0.0)', '32');
        testValue('Math.clz32(-0.0)', '32');
        let x = 1;
        for (let i = 31; i >= 0; i--) {
            testValue(`Math.clz32(${x})`, String(i));
            testValue(`Math.clz32(${2 * x - 1})`, String(i));
            x *= 2;
        }
        testValue("Math.clz32('52')", '26');
        testValue('Math.clz32([52])', '26');
        testValue('Math.clz32([52, 53])', '32');

        // Overflow cases
        testValue('Math.clz32(0x100000000)', '32');
        testValue('Math.clz32(0x100000001)', '31');

        // Negative cases
        testValue('Math.clz32(-1)', '0');
        testValue('Math.clz32(-2147483647)', '0');
        testValue('Math.clz32(-2147483649)', '1');

        // NaN -> 0
        testValue('Math.clz32(NaN)', '32');
        testValue("Math.clz32('foo')", '32');
        testValue('Math.clz32(Infinity)', '32');
    });

    it('test_fold_math_functions_max', () => {
        testSameValue('Math.max(Math.random(), 1)');

        testValue('Math.max()', '-Infinity');
        testValue('Math.max(0)', '0');
        testValue('Math.max(0, 1)', '1');
        testValue('Math.max(0, 1, -1, 200)', '200');
        testValue('Math.max(0, -1, -Infinity)', '0');
        testValue('Math.max(0, -1, -Infinity, NaN)', 'NaN');
        testValue('Math.max(0, -0)', '0');
        testValue('Math.max(-0, 0)', '0');
        testSameValue('Math.max(...a, 1)');
    });

    it('test_fold_math_functions_min', () => {
        testSameValue('Math.min(Math.random(), 1)');

        testValue('Math.min()', 'Infinity');
        testValue('Math.min(3)', '3');
        testValue('Math.min(0, 1)', '0');
        testValue('Math.min(0, 1, -1, 200)', '-1');
        testValue('Math.min(0, -1, -Infinity)', '-Infinity');
        testValue('Math.min(0, -1, -Infinity, NaN)', 'NaN');
        testValue('Math.min(0, -0)', '-0');
        testValue('Math.min(-0, 0)', '-0');
        testSameValue('Math.min(...a, 1)');
    });

    it('test_fold_math_functions_pow', () => {
        testValue('Math.pow(1, 2)', '1');
        testValue('Math.pow(2, 0)', '1');
        testValue('Math.pow(2, 2)', '4');
        testValue('Math.pow(2, 32)', '2 ** 32');
        testValue('Math.pow(Infinity, 0)', '1');
        testValue('Math.pow(Infinity, 1)', 'Infinity');
        testValue("Math.pow('a', 33)", 'NaN');
        testValue('Math.pow(2, 3)', '8');
        testValue('Math.pow(a, 3)', 'a ** 3');
        testValue('Math.pow(a, b)', 'a ** +b');
        testValue('Math.pow(2n, 3n)', '2n ** +3n'); // errors both before and after
        testValue('Math.pow(a + b, c)', '(a + b) ** +c');
        testSameValue('Math.pow()');
        testSameValue('Math.pow(1)');
        testSameValue('Math.pow(...a, 1)');
        testSameValue('Math.pow(1, ...a)');
        testSameValue('Math.pow(1, 2, 3)');
        testTargetNamed('v = Math.pow(2, 3)', 'v = Math.pow(2, 3)', 'chrome51');
        testSameValue(' Unknown.pow(1, 2)');
    });

    it.skip('test_fold_math_functions_pow: needs substitute_unary_plus (substitute-alternate-syntax)', () => {
        testValue('Math.pow(2, b)', '2 ** b');
    });

    it('test_fold_math_functions_sqrt', () => {
        testSameValue('Math.sqrt()');
        testSameValue('Math.sqrt(1, 2)');
        testSameValue('Math.sqrt(...a)');
        testSameValue('Math.sqrt(a)'); // a maybe -0
        testSameValue('Math.sqrt(2n)');
        testValue('Math.sqrt(Infinity)', 'Infinity');
        testValue('Math.sqrt(NaN)', 'NaN');
        testValue('Math.sqrt(0)', '0');
        testValue('Math.sqrt(-0)', '-0');
        testValue('Math.sqrt(-1)', 'NaN');
        testValue('Math.sqrt(-Infinity)', 'NaN');
        testValue('Math.sqrt(1)', '1');
        testValue('Math.sqrt(4)', '2');
        testSameValue('Math.sqrt(2)');
        testSameValue('Unknown.sqrt(1)');
    });

    it('test_fold_math_functions_cbrt', () => {
        testValue('Math.cbrt(1)', '1');
        testValue('Math.cbrt(8)', '2');
        testSameValue('Math.cbrt(2)');
        testSameValue('Unknown.cbrt(1)');
    });

    it.skip('test_fold_number_functions_is_safe_integer: needs substitute_boolean (substitute-alternate-syntax)', () => {
        testValue('Number.isSafeInteger(1)', '!0');
        testValue('Number.isSafeInteger(1.5)', '!1');
        testValue('Number.isSafeInteger(9007199254740991)', '!0');
        testValue('Number.isSafeInteger(9007199254740992)', '!1');
        testValue('Number.isSafeInteger(-9007199254740991)', '!0');
        testValue('Number.isSafeInteger(-9007199254740992)', '!1');
    });

    it('test_fold_number_functions_is_finite', () => {
        testSameValue("Number.isFinite('a')");
    });

    it.skip('test_fold_number_functions_is_finite: needs substitute_boolean (substitute-alternate-syntax)', () => {
        testValue('Number.isFinite(1)', '!0');
        testValue('Number.isFinite(1.5)', '!0');
        testValue('Number.isFinite(NaN)', '!1');
        testValue('Number.isFinite(Infinity)', '!1');
        testValue('Number.isFinite(-Infinity)', '!1');
    });

    it('test_fold_number_functions_is_nan', () => {
        testSameValue("Number.isNaN('a')");
        // unknown function may have side effects
        testSameValue('Number.isNaN(+(void unknown()))');
    });

    it.skip('test_fold_number_functions_is_nan: needs substitute_boolean (substitute-alternate-syntax)', () => {
        testValue('Number.isNaN(1)', '!1');
        testValue('Number.isNaN(1.5)', '!1');
        testValue('Number.isNaN(NaN)', '!0');
    });

    it('test_fold_parse_numbers', () => {
        test("x = parseInt('123')", 'x = 123');
        test('x = parseInt(`123`)', 'x = 123');
        test('x = parseInt(` 123`)', 'x = 123');
        testSame('x = parseInt(`12 ${a}`)');
        test("x = parseFloat('1.23')", 'x = 1.23');
        test('x = parseFloat(`1.23`)', 'x = 1.23');
        testSame('x = parseFloat(`1.${a}`)');

        test("x = parseInt('123')", 'x = 123');
        test("x = parseInt(' 123')", 'x = 123');
        test("x = parseInt('123', 10)", 'x = 123');
        test("x = parseInt('0xA')", 'x = 10');
        test("x = parseInt('0xA', 16)", 'x = 10');
        test("x = parseInt('07', 8)", 'x = 7');
        test("x = parseInt('08')", 'x = 8');
        test("x = parseInt('0')", 'x = 0');
        test("x = parseInt('-0')", 'x = -0');
        test("x = parseFloat('0')", 'x = 0');
        test("x = parseFloat('1.23')", 'x = 1.23');
        test("x = parseFloat('-1.23')", 'x = -1.23');
        test("x = parseFloat('1.2300')", 'x = 1.23');
        test("x = parseFloat(' 0.3333')", 'x = 0.3333');
        test("x = parseFloat('0100')", 'x = 100');
        test("x = parseFloat('0100.000')", 'x = 100');

        // Mozilla Dev Center test cases
        test("x = parseInt(' 0xF', 16)", 'x = 15');
        test("x = parseInt(' F', 16)", 'x = 15');
        test("x = parseInt('17', 8)", 'x = 15');
        test("x = parseInt('015', 10)", 'x = 15');
        test("x = parseInt('1111', 2)", 'x = 15');
        testSame("x = parseInt('12', 13)");
        test('x = parseInt(15.99, 10)', 'x = 15');
        test('x = parseInt(-15.99, 10)', 'x = -15');
        test("x = parseInt('-15.99', 10)", 'x = -15');
        test("x = parseFloat('3.14')", 'x = 3.14');
        test('x = parseFloat(3.14)', 'x = 3.14');
        test('x = parseFloat(-3.14)', 'x = -3.14');
        test("x = parseFloat('-3.14')", 'x = -3.14');
        test("x = parseFloat('-0')", 'x = -0');

        test("x = parseInt('FXX123', 16)", 'x = 15'); // Parses 'F' (15 in hex)
        test("x = parseInt('15*3', 10)", 'x = 15'); // Parses '15', stops at '*'
        test("x = parseInt('15e2', 10)", 'x = 15'); // Parses '15', stops at 'e'
        test("x = parseInt('15px', 10)", 'x = 15'); // Parses '15', stops at 'p'
        test("x = parseInt('-0x08')", 'x = -8');
        test("x = parseInt('1', -1)", 'x = NaN');
        test("x = parseFloat('3.14more non-digit characters')", 'x = 3.14'); // Parses '3.14', stops at 'm'
        test("x = parseFloat('314e-2')", 'x = 3.14');
        test("x = parseFloat('0.0314E+2')", 'x = 3.14');
        test("x = parseFloat('3.333333333333333333333333')", 'x = 3.3333333333333335');

        test("x = parseInt('0xa', 10)", 'x = 0'); // Parses '0' in base 10, stops at 'x'
        test("x = parseInt('')", 'x = NaN');
    });

    it('test_fold_parse_octal_numbers', () => {
        test("x = parseInt('021', 8)", 'x = 17');
        test("x = parseInt('-021', 8)", 'x = -17');
    });

    it('test_fold_parse_numbers_additional', () => {
        testValue("parseInt('+1')", '1');
        testValue("parseFloat('+1')", '1');
        testValue("parseInt('10', 0)", '10');
        testValue("parseInt('0x10', 16)", '16');
        testValue("parseInt('')", 'NaN');
        testValue("parseInt(' ')", 'NaN');
        testValue("parseInt('abc')", 'NaN');
        testValue("parseFloat('')", 'NaN');
        testValue("parseFloat(' ')", 'NaN');
        testValue("parseFloat('abc')", 'NaN');
        testValue("parseFloat('Infinity')", 'Infinity');
        testValue("parseFloat('-Infinity')", '-Infinity');
        testValue("parseFloat('+Infinity')", 'Infinity');
        testSameValue('parseInt(unknown)');
        testSameValue("parseInt((foo, '0'))"); // foo may have side effects
        testSameValue('parseFloat(unknown)');
        testSameValue("parseFloat((foo, '0'))"); // foo may have side effects
    });

    it.skip('test_replace_with_char_at: ignored in oxc, TODO: String charAt replacement optimization not yet implemented', () => {
        // enableTypeCheck();
        // replaceTypesWithColors();
        // disableCompareJsDoc();

        foldStringTyped('a.substring(0, 1)', 'a.charAt(0)');
        testSameStringTyped('a.substring(-4, -3)');
        testSameStringTyped('a.substring(i, j + 1)');
        testSameStringTyped('a.substring(i, i + 1)');
        testSameStringTyped('a.substring(1, 2, 3)');
        testSameStringTyped('a.substring()');
        testSameStringTyped('a.substring(1)');
        testSameStringTyped('a.substring(1, 3, 4)');
        testSameStringTyped('a.substring(-1, 3)');
        testSameStringTyped('a.substring(2, 1)');
        testSameStringTyped('a.substring(3, 1)');

        foldStringTyped('a.slice(4, 5)', 'a.charAt(4)');
        testSameStringTyped('a.slice(-2, -1)');
        foldStringTyped('var /** number */ i; a.slice(0, 1)', 'var /** number */ i; a.charAt(0)');
        testSameStringTyped('a.slice(i, j + 1)');
        testSameStringTyped('a.slice(i, i + 1)');
        testSameStringTyped('a.slice(1, 2, 3)');
        testSameStringTyped('a.slice()');
        testSameStringTyped('a.slice(1)');
        testSameStringTyped('a.slice(1, 3, 4)');
        testSameStringTyped('a.slice(-1, 3)');
        testSameStringTyped('a.slice(2, 1)');
        testSameStringTyped('a.slice(3, 1)');

        // enableTypeCheck();

        testSame('function f(/** ? */ a) { a.substring(0, 1); }');
        // testSame(lines(
        //     "/** @constructor */ function A() {};",
        //     "A.prototype.substring = function(begin, end) {};",
        //     "function f(/** !A */ a) { a.substring(0, 1); }",
        // ));
        // testSame(lines(
        //     "/** @constructor */ function A() {};",
        //     "A.prototype.slice = function(begin, end) {};",
        //     "function f(/** !A */ a) { a.slice(0, 1); }",
        // ));

        // useTypes = false;
        testSameStringTyped('a.substring(0, 1)');
        testSameStringTyped("''.substring(i, i + 1)");
    });

    it('test_fold_concat_chaining', () => {
        // array
        test("x = [1,2].concat(1).concat(2,['abc']).concat('abc')", "x = [1,2,1,2,'abc','abc']");
        test("x = [].concat(['abc']).concat(1).concat([2,3])", "x = ['abc',1,2,3]");
        test("x = [].concat(1).concat(2).join(',')", "x = [1,2].join(',')");

        test('var x, y; [1].concat(x).concat(y)', 'var x, y; [1].concat(x, y)');
        test('var y; [1].concat(x).concat(y)', 'var y; [1].concat(x, y)'); // x might have a getter that updates y, but that side effect is preserved correctly
        test('var x; [1].concat(x.a).concat(x)', 'var x; [1].concat(x.a, x)'); // x.a might have a getter that updates x, but that side effect is preserved correctly
        testSame('x = [].map(a => a + 1).concat(1)');

        // string
        test("x = ''.concat('a', ' ').concat('b').split(/[\\s\\n]+/)", "x = 'a b'.split(/[\\s\\n]+/)");
        testSame("x = ''.split().concat(1)");

        test("var x, y; v = ''.concat(x).concat(y)", 'var x, y; v = `${x}${y}`');
        test("var y; v = ''.concat(x).concat(y)", 'var y; v = `${x}${y}`'); // x might have a getter that updates y, but that side effect is preserved correctly
        test("var x; v = ''.concat(x.a).concat(x)", 'var x; v = `${x.a}${x}`'); // x.a might have a getter that updates x, but that side effect is preserved correctly

        // other
        test("x = []['concat'](1)", 'x = [1]');
        testSame('x = obj.concat([1,2]).concat(1)');
    });

    it.skip('test_fold_concat_chaining: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test("x = '1'.concat(1).concat(2,['abc']).concat('abc')", "x = '112abcabc'");
        test("x = ''.concat(['abc']).concat(1).concat([2,3])", "x = 'abc12,3'");
        test("x = ''.concat(1)", "x = '1'");
        test("x = ''['concat'](1)", "x = '1'");
    });

    it('test_add_template_literal', () => {
        test("x = '$' + `{${x}}`", 'x = `\\${${x}}`');
        test("x = `{${x}}` + '$'", 'x = `{${x}}\\$`');
        // `\r` must be escaped, otherwise the parser would normalize a literal CR
        // in template raw to `\n` on re-parse, changing the cooked value.
        testValue("'\\r' + `${x}`", '`\\r${x}`');
        testValue("'\\r\\n' + `${x}`", '`\\r\n${x}`');
        testValue("'\\r\\rfoo' + `${x}`", '`\\r\\rfoo${x}`');
    });

    it.skip('test_add_template_literal: needs substitute_template_literal (substitute-alternate-syntax)', () => {
        test('x = `$` + `{${x}}`', 'x = `\\${${x}}`');
        test('x = `{${x}}` + `$`', 'x = `{${x}}\\$`');
    });

    it('test_remove_array_literal_from_front_of_concat', () => {
        test('x = [].concat([1,2,3],1)', 'x = [1,2,3,1]');

        testSame('[1,2,3].concat(foo())');
        // Call method with the same name as Array.prototype.concat
        testSame('obj.concat([1,2,3])');

        test('x = [].concat(1,[1,2,3])', 'x = [1,1,2,3]');
        test('x = [].concat(1)', 'x = [1]');
        test('x = [].concat([1])', 'x = [1]');

        // Chained folding of empty array lit
        test('x = [].concat([], [1,2,3], [4])', 'x = [1,2,3,4]');
        test('x = [].concat([]).concat([1]).concat([2,3])', 'x = [1,2,3]');

        test('x = [].concat(1, x)', 'x = [1].concat(x)'); // x might be an array or an object with `Symbol.isConcatSpreadable`
        test('x = [].concat(1, ...x)', 'x = [1].concat(...x)');
        testSame('x = [].concat(x, 1)');
    });

    it.skip('test_array_of_spread: needs try_flatten_array_expression_elements (substitute-alternate-syntax)', () => {
        test("x = Array.of(...['a', 'b', 'c'])", "x = ['a', 'b', 'c']");
        test("x = Array.of(...['a', 'b', 'c',])", "x = ['a', 'b', 'c']");
        test("x = Array.of(...['a'], ...['b', 'c'])", "x = ['a', 'b', 'c']");
        test("x = Array.of('a', ...['b', 'c'])", "x = ['a', 'b', 'c']");
        test("x = Array.of('a', ...['b', 'c'])", "x = ['a', 'b', 'c']");
    });

    it('test_array_of_no_spread', () => {
        test("x = Array.of('a', 'b', 'c')", "x = ['a', 'b', 'c']");
        test("x = Array.of('a', ['b', 'c'])", "x = ['a', ['b', 'c']]");
        test("x = Array.of('a', ['b', 'c'],)", "x = ['a', ['b', 'c']]");
    });

    it('test_array_of_no_args', () => {
        test('x = Array.of()', 'x = []');
    });

    it('test_array_of_no_change', () => {
        testSame("x = Array.of.apply(window, ['a', 'b', 'c'])");
        testSame("x = ['a', 'b', 'c']");
        testSame("x = [Array.of, 'a', 'b', 'c']");
    });

    it('test_fold_array_bug', () => {
        testSame('Array[123]()');
    });

    it('test_fold_string_from_char_code', () => {
        test('x = String.fromCharCode()', "x = ''");
        test('x = String.fromCharCode(0)', "x = '\\0'");
        test('x = String.fromCharCode(120)', "x = 'x'");
        test('x = String.fromCharCode(120, 121)', "x = 'xy'");
        testSame('x = String.fromCharCode(55358, 56768)');
        test('x = String.fromCharCode(0x10000)', "x = '\\0'");
        test('x = String.fromCharCode(0x10078, 0x10079)', "x = 'xy'");
        test('x = String.fromCharCode(0x1_0000_FFFF)', "x = '\u{ffff}'");
        test('x = String.fromCharCode(NaN)', "x = '\\0'");
        test('x = String.fromCharCode(-Infinity)', "x = '\\0'");
        test('x = String.fromCharCode(Infinity)', "x = '\\0'");
        test('x = String.fromCharCode(null)', "x = '\\0'");
        test('x = String.fromCharCode(undefined)', "x = '\\0'");
        test("x = String.fromCharCode('123')", "x = '{'");
        testSame('String.fromCharCode(x)');
        test("x = String.fromCharCode('x')", "x = '\\0'");
        test("x = String.fromCharCode('0.5')", "x = '\\0'");

        testSame("x = Unknown.fromCharCode('0.5')");
    });

    it('test_fold_string_concat', () => {
        testSame("x = ''.concat()");
        test("x = ''.concat(a, b)", 'x = `${a}${b}`');
        test("x = ''.concat(a, b, c)", 'x = `${a}${b}${c}`');
        test("x = ''.concat(a, b, c, d)", 'x = `${a}${b}${c}${d}`');
        testSame("x = ''.concat(a, b, c, d, e)");
        test("x = ''.concat('a')", "x = 'a'");
        test("x = ''.concat('a', 'b')", "x = 'ab'");
        test("x = ''.concat('a', 'b', 'c')", "x = 'abc'");
        test("x = ''.concat('a', 'b', 'c', 'd')", "x = 'abcd'");
        test("x = ''.concat('a', 'b', 'c', 'd', 'e')", "x = 'abcde'");
        test("x = ''.concat(a, 'b')", 'x = `${a}b`');
        test("x = ''.concat('a', b)", 'x = `a${b}`');
        test("x = ''.concat(a, 'b', c)", 'x = `${a}b${c}`');
        test("x = ''.concat('a', b, 'c')", 'x = `a${b}c`');
        test(
            "x = ''.concat('a', b, 'c', d, 'e', f, 'g', h, 'i', j, 'k', l, 'm', n, 'o', p, 'q', r, 's', t)",
            'x = `a${b}c${d}e${f}g${h}i${j}k${l}m${n}o${p}q${r}s${t}`',
        );
        test("x = ''.concat(a, 1)", 'x = `${a}1`');

        test("x = '\\\\s'.concat(a)", 'x = `\\\\s${a}`');
        test("x = '`'.concat(a)", 'x = `\\`${a}`');
        test("x = '${'.concat(a)", 'x = `\\${${a}`');
    });

    it('test_to_string', () => {
        test("x = false['toString']()", "x = 'false';");
        test('x = false.toString()', "x = 'false';");
        test('x = true.toString()', "x = 'true';");
        test('x = (!0).toString()', "x = 'true';");
        test('x = (!1).toString()', "x = 'false';");
        test("x = 'xy'.toString()", "x = 'xy';");
        test('x = 0 .toString()', "x = '0';");
        test('x = 123 .toString()', "x = '123';");
        test('x = NaN.toString()', "x = 'NaN';");
        test('x = NaN.toString(2)', "x = 'NaN';");
        test('x = Infinity.toString()', "x = 'Infinity';");
        test('x = Infinity.toString(2)', "x = 'Infinity';");
        test('x = (-Infinity).toString(2)', "x = '-Infinity';");
        test('x = 1n.toString()', "x = '1'");
        testSame('254n.toString(16);'); // unimplemented
        // test("/a\\\\b/ig.toString()", "'/a\\\\\\\\b/ig';");
        testSame('null.toString()'); // type error
        testSame('x = (f(), 5).toString()');
        testSame('async function t(p) { x = (await p, 5).toString(); } t(p)');

        test('x = 100 .toString(0)', 'x = 100 .toString(0)');
        test('x = 100 .toString(1)', 'x = 100 .toString(1)');
        test('x = 100 .toString(2)', "x = '1100100'");
        test('x = 100 .toString(5)', "x = '400'");
        test('x = 100 .toString(8)', "x = '144'");
        test('x = 100 .toString(13)', "x = '79'");
        test('x = 100 .toString(16)', "x = '64'");
        test('x = 10000 .toString(19)', "x = '18d6'");
        test('x = 10000 .toString(23)', "x = 'iki'");
        test('x = 1000000 .toString(29)', "x = '1c01m'");
        test('x = 1000000 .toString(31)', "x = '12hi2'");
        test('x = 1000000 .toString(36)', "x = 'lfls'");
        test('x = 0 .toString(36)', "x = '0'");
        test('x = 0.5.toString()', "x = '0.5'");

        test("'xy'.toString(b)", "'xy'.toString(b)");
        test('123 .toString(b)', '123 .toString(b)');
        test('1e99.toString(b)', '1e99.toString(b)');
        test('/./.toString(b)', '/./.toString(b)');
    });

    it.skip('test_to_string: needs substitute_boolean (substitute-alternate-syntax)', () => {
        test('false.toString(b)', '(!1).toString(b)');
        test('true.toString(b)', '(!0).toString(b)');
    });

    it('test_number_constants', () => {
        test('v = Number.POSITIVE_INFINITY', 'v = Infinity');
        test('v = Number.NEGATIVE_INFINITY', 'v = -Infinity');
        test('v = Number.NaN', 'v = NaN');
        test('v = Number.MAX_SAFE_INTEGER', 'v = 2**53-1');
        test('v = Number.MIN_SAFE_INTEGER', 'v = -(2**53-1)');
        test('v = Number.EPSILON', 'v = 2**-52');

        testSame('Number.POSITIVE_INFINITY = 1');
        testSame('Number.NEGATIVE_INFINITY = 1');
        testSame('Number.NaN = 1');
        testSame('Number.MAX_SAFE_INTEGER = 1');
        testSame('Number.MIN_SAFE_INTEGER = 1');
        testSame('Number.EPSILON = 1');

        testTargetNamed('v = Number.MAX_SAFE_INTEGER', 'v = 9007199254740991', 'chrome51');
        testTargetNamed('v = Number.MIN_SAFE_INTEGER', 'v = -9007199254740991', 'chrome51');
        testTargetNamed('v = Number.EPSILON', 'v = Number.EPSILON', 'chrome51');
    });

    it('test_fold_integer_index_access', () => {
        testSame("v = ''[0]");
        testSame("v = 'a'[-1]");
        testSame("v = 'a'[0.3]");
        test("v = 'a'[0]", "v = 'a'");
        testSame("v = 'a'[1]");
        test("v = '\u{3042}'[0]", "v = '\u{3042}'");
        testSame("v = '\u{3042}'[1]");
        testSame("v = '\u{1f600}'[0]"); // surrogate pairs cannot be represented by rust string
        testSame("v = '\u{1f600}'[1]"); // surrogate pairs cannot be represented by rust string
        testSame("v = '\u{1f600}'[2]");
        testSame("v = (foo(), 'a')[1]"); // can be fold into `v = (foo(), 'a')`

        testSame('v = [][0]');
        testSame('v = [1][-1]');
        testSame('v = [1][0.3]');
        test('v = [1][0]', 'v = 1');
        testSame('v = [1][1]');
        test('v = [,][0]', 'v = void 0');
        // test("v = [...'a'][0]", "v = 'a'");
        // testSame("v = [...'a'][1]");
        // test("v = [...'\u{1f600}'][0]", "v = '\u{1f600}'");
        // testSame("v = [...'\u{1f600}'][1]");
        testSame('v = [...a, 1][1]');
        testSame('v = [1, ...a][0]');
        test('v = [1, ...[1,2]][0]', 'v = 1');

        // property access should be kept to keep `this` value
        testSame("\n        function f(){ console.log(this[0]) }\n        ['PASS',f][1]()\n    ");
        testSame("\n        function f(){ console.log(this[0]) }\n        ['PASS',f][1]``\n    ");
    });

    it('test_fold_starts_with', () => {
        testSame("v = 'production'.startsWith('prod', 'bar')");
    });

    it.skip('test_fold_starts_with: needs substitute_boolean (substitute-alternate-syntax)', () => {
        test("v = 'production'.startsWith('prod')", 'v = !0');
        test("v = 'production'.startsWith('dev')", 'v = !1');
        test(
            "const node_env = 'production'; v = node_env.toLowerCase().startsWith('prod')",
            "const node_env = 'production'; v = !0",
        );
    });

    it('test_fold_encode_uri', () => {
        test('x = encodeURI()', "x = 'undefined'");
        test("x = encodeURI('hello')", "x = 'hello'");
        test("x = encodeURI('hello world')", "x = 'hello%20world'");
        test("x = encodeURI('http://example.com/path?a=1&b=2#hash')", "x = 'http://example.com/path?a=1&b=2#hash'");
        test("x = encodeURI('a;b,c/d?e:f@g&h=i+j$k')", "x = 'a;b,c/d?e:f@g&h=i+j$k'");
        test("x = encodeURI('ABC-_abc.!~*()123')", "x = 'ABC-_abc.!~*()123'");
        test("x = encodeURI('hello<>\"')", "x = 'hello%3C%3E%22'");
        test("x = encodeURI('hello\\t\\n')", "x = 'hello%09%0A'");
        test("x = encodeURI('caf\u{e9}')", "x = 'caf%C3%A9'"); // spellchecker:disable-line
        test("x = encodeURI('\u{6d4b}\u{8bd5}')", "x = '%E6%B5%8B%E8%AF%95'");

        testSame("x = encodeURI('a', 'b')");
        testSame('x = encodeURI(x)');
    });

    it('test_fold_encode_uri_component', () => {
        test('x = encodeURIComponent()', "x = 'undefined'");
        test("x = encodeURIComponent('hello')", "x = 'hello'");
        test("x = encodeURIComponent('ABC-_abc.!~*()123')", "x = 'ABC-_abc.!~*()123'");
        test("x = encodeURIComponent('a;b,c/d?e:f@g&h=i+j$k')", "x = 'a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k'");
        test("x = encodeURIComponent('#')", "x = '%23'");
        test("x = encodeURIComponent('hello world')", "x = 'hello%20world'");
        test("x = encodeURIComponent('hello<>\"')", "x = 'hello%3C%3E%22'");
        test("x = encodeURIComponent('caf\u{e9}')", "x = 'caf%C3%A9'"); // spellchecker:disable-line
        test("x = encodeURIComponent('\u{6d4b}\u{8bd5}')", "x = '%E6%B5%8B%E8%AF%95'");

        testSame("x = encodeURIComponent('a', 'b')");
        testSame('x = encodeURIComponent(x)');
    });

    it('test_fold_decode_uri', () => {
        test('x = decodeURI()', "x = 'undefined'");
        test("x = decodeURI('hello%20world')", "x = 'hello world'");
        test("x = decodeURI('hello')", "x = 'hello'");
        test("x = decodeURI('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')", "x = 'a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k'");
        test("x = decodeURI('%2f')", "x = '%2f'"); // `/`, lower case
        test("x = decodeURI('%23')", "x = '%23'"); // `#`
        test("x = decodeURI('%23hash')", "x = '%23hash'");
        test("x = decodeURI('hello%3C%3E%22')", "x = 'hello<>\"'");
        test("x = decodeURI('hello%09%0A')", "x = 'hello\\t\\n'");
        test("x = decodeURI('caf%C3%A9')", "x = 'caf\u{e9}'"); // spellchecker:disable-line
        test("x = decodeURI('%E6%B5%8B%E8%AF%95')", "x = '\u{6d4b}\u{8bd5}'");

        testSame("x = decodeURI('%ZZ')"); // URIError
        testSame("x = decodeURI('%A')"); // URIError

        testSame("x = decodeURI('a', 'b')");
        testSame('x = decodeURI(x)');
    });

    it('test_fold_decode_uri_component', () => {
        test('x = decodeURIComponent()', "x = 'undefined'");
        test("x = decodeURIComponent('hello%20world')", "x = 'hello world'");
        test("x = decodeURIComponent('hello')", "x = 'hello'");
        test("x = decodeURIComponent('a%3Bb%2Cc%2Fd%3Fe%3Af%40g%26h%3Di%2Bj%24k')", "x = 'a;b,c/d?e:f@g&h=i+j$k'");
        test("x = decodeURIComponent('%23')", "x = '#'");
        test("x = decodeURIComponent('%23hash')", "x = '#hash'");
        test("x = decodeURIComponent('hello%3C%3E%22')", "x = 'hello<>\"'");
        test("x = decodeURIComponent('hello%09%0A')", "x = 'hello\\t\\n'");
        test("x = decodeURIComponent('caf%C3%A9')", "x = 'caf\u{e9}'"); // spellchecker:disable-line
        test("x = decodeURIComponent('%E6%B5%8B%E8%AF%95')", "x = '\u{6d4b}\u{8bd5}'");

        testSame("x = decodeURIComponent('%ZZ')"); // URIError
        testSame("x = decodeURIComponent('%A')"); // URIError

        testSame("x = decodeURIComponent('a', 'b')");
        testSame('x = decodeURIComponent(x)');
    });

    it('test_fold_uri_roundtrip', () => {
        test("x = decodeURI(encodeURI('hello world'))", "x = 'hello world'");
        test("x = decodeURIComponent(encodeURIComponent('hello world'))", "x = 'hello world'");
        test("x = decodeURIComponent(encodeURIComponent('a;b,c/d?e:f@g&h=i+j$k'))", "x = 'a;b,c/d?e:f@g&h=i+j$k'");
        test("x = decodeURI(encodeURI('caf\u{e9}'))", "x = 'caf\u{e9}'");
        test("x = decodeURIComponent(encodeURIComponent('\u{6d4b}\u{8bd5}'))", "x = '\u{6d4b}\u{8bd5}'");
    });

    it('test_fold_global_is_nan', () => {
        testSameValue('isNaN(unknown)');
        testSameValue('isNaN((foo, 0))'); // foo may have sideeffect
    });

    it.skip('test_fold_global_is_nan: needs substitute_boolean (substitute-alternate-syntax)', () => {
        testValue('isNaN()', '!0');
        testValue('isNaN(NaN)', '!0');
        testValue('isNaN(123)', '!1');
        testValue("isNaN('123')", '!1');
        testValue("isNaN('abc')", '!0');
        testValue("isNaN('')", '!1');
        testValue("isNaN(' ')", '!1');
        testValue('isNaN(null)', '!1');
        testValue('isNaN(Infinity)', '!1');
        testValue('isNaN(-Infinity)', '!1');
    });

    it('test_fold_global_is_finite', () => {
        testSameValue('isFinite(unknown)');
        testSameValue('isFinite((foo, 0))'); // foo may have sideeffect
    });

    it.skip('test_fold_global_is_finite: needs substitute_boolean (substitute-alternate-syntax)', () => {
        testValue('isFinite()', '!1');
        testValue('isFinite(123)', '!0');
        testValue('isFinite(123.45)', '!0');
        testValue("isFinite('123')", '!0');
        testValue("isFinite('')", '!0');
        testValue("isFinite(' ')", '!0');
        testValue('isFinite(null)', '!0');
        testValue('isFinite(NaN)', '!1');
        testValue('isFinite(Infinity)', '!1');
        testValue('isFinite(-Infinity)', '!1');
        testValue("isFinite('abc')", '!1');
    });

    it('test_fold_regex_source', () => {
        testValue('/abc def/.source', "'abc def'");
        testValue('/\\d+/.source', "'\\\\d+'");
        testValue('/[a-z]/.source', "'[a-z]'");
        testValue('/a|b/.source', "'a|b'");
        testValue('/^test$/.source', "'^test$'");
        testValue('/./.source', "'.'");
        testValue('/.*/.source', "'.*'");

        testValue('/abc def/i.source', "'abc def'");
        testSameValue('/(/.source'); // this regex is invalid
        testValue('/\\u{}/.source', "'\\\\u{}'");
        testSameValue('/\\u{}/u.source'); // this regex is invalid, also u flag is not supported by ES2015

        // Preserve newer RegExp syntax unless every configured target supports it.
        testSameValue('/a/u.source');
        for (const [source, expected, unsupportedTarget, supportedTarget] of [
            ['x = /a/y.source', "x = 'a'", 'chrome48', 'es2015'],
            ['x = /a/u.source', "x = 'a'", 'chrome49', 'es2015'],
            ['x = /a/s.source', "x = 'a'", 'es2017', 'es2018'],
            ['x = /a/d.source', "x = 'a'", 'es2021', 'es2022'],
            ['x = /a/v.source', "x = 'a'", 'es2023', 'es2024'],
            ['x = /(?<name>a)/.source', "x = '(?<name>a)'", 'es2017', 'es2018'],
            [`x = /\\p{Ll}/u.source`, `x = '\\\\p{Ll}'`, 'es2017', 'es2018'],
            ['x = /(?<=a)b/.source', "x = '(?<=a)b'", 'es2017', 'es2018'],
            ['x = /(?<name>a)|(?<name>b)/.source', "x = '(?<name>a)|(?<name>b)'", 'es2024', 'es2025'],
            ['x = /(?i:a)/.source', "x = '(?i:a)'", 'es2024', 'es2025'],
        ] as const) {
            testTargetNamed(source, source, unsupportedTarget);
            testTargetNamed(source, expected, supportedTarget);
        }
    });
});
