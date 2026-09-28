// Port of oxc_minifier/tests/peephole/convert_to_dotted_properties.rs.
import { describe, it } from 'vitest';
import { test, testSame } from './harness.ts';

describe('convert_to_dotted_properties', () => {
    it('test_computed_to_member_expression', () => {
        test("x['true']", 'x.true');
        testSame("x['\u{1f60a}']");
    });

    it('test_convert_to_dotted_properties_convert', () => {
        test("a['p']", 'a.p');
        test("a['_p_']", 'a._p_');
        test("a['_']", 'a._');
        test("a['$']", 'a.$');
        test("a.b.c['p']", 'a.b.c.p');
        test("a.b['c'].p", 'a.b.c.p');
        test("a['p']();", 'a.p();');
        test("a()['p']", 'a().p');
        // ASCII in Unicode is always safe.
        test("a['\\u0041A']", 'a.AA');
        // This is safe for ES5+. (keywords cannot be used for ES3)
        test("a['default']", 'a.default');
        // This is safe for ES2015+. (\u1d17 was introduced in Unicode 3.1, ES2015+ uses Unicode 5.1+)
        test("a['\\u1d17A']", 'a.\u{1d17}A');
        // Latin capital N with tilde - this is safe for ES3+.
        test("a['\\u00d1StuffAfter']", 'a.\u{00d1}StuffAfter');
    });

    it('test_convert_to_dotted_properties_do_not_convert', () => {
        testSame('a[0]');
        testSame("a['']");
        testSame("a[' ']");
        testSame("a[',']");
        testSame("a[';']");
        testSame("a[':']");
        testSame("a['.']");
        testSame("a['p ']");
        test("a['p' + '']", 'a.p');
        testSame('a[p]');
        testSame('a[P]');
        testSame('a[$]');
        testSame('a[p()]');
        // Ignorable control characters are ok in Java identifiers, but not in JS.
        testSame("a['A\\u0004']");
    });

    it('test_convert_to_dotted_properties_already_dotted', () => {
        testSame('a.b');
        testSame('var a = {b: 0};');
    });

    it('test_convert_to_dotted_properties_quoted_props', () => {
        testSame("v = ({'':0})");
        testSame("v = ({'1.0':0})");
        // test("v = ({'a\\u0004b':0})");
    });

    it.skip('test_convert_to_dotted_properties_quoted_props: needs substitute_object_property (substitute-alternate-syntax)', () => {
        test("v = ({'\\u1d17A':0})", 'v = ({ \u{1d17}A: 0 })');
    });

    it('test5746867', () => {
        testSame("var a = { '$\\\\' : 5 };");
        testSame("var a = { 'x\\\\u0041$\\\\' : 5 };");
    });

    it('test_convert_to_dotted_properties_optional_chaining', () => {
        test("data?.['name']", 'data?.name');
        test("data?.['name']?.['first']", 'data?.name?.first');
        test("data['name']?.['first']", 'data.name?.first');
        testSame('a?.[0]');
        testSame("a?.['']");
        testSame("a?.[' ']");
        testSame("a?.[',']");
        testSame("a?.[';']");
        testSame("a?.[':']");
        testSame("a?.['.']");
        testSame("a?.['0']");
        testSame("a?.['p ']");
        test("a?.['p' + '']", 'a?.p');
        testSame('a?.[p]');
        testSame('a?.[P]');
        testSame('a?.[$]');
        testSame('a?.[p()]');
        // This is safe for ES5+. (keywords cannot be used for ES3)
        test("a?.['default']", 'a?.default');
    });

    it('test_convert_to_dotted_properties_computed_property_or_field', () => {
        // test static keyword

        testSame('const o = {[fn()]: 0}');
        testSame("class C { ['constructor']() {} }");
        testSame("class C { ['constructor'] = 0 }");
    });

    it.skip('test_convert_to_dotted_properties_computed_property_or_field: needs substitute_object_property, substitute_method_definition, substitute_property_definition (substitute-alternate-syntax)', () => {
        test("const test1 = {['prop1']:87};", 'const test1 = {prop1:87};');
        test("const test1 = {['prop1']:87,['prop2']:bg,['prop3']:'hfd'};", "const test1 = {prop1:87,prop2:bg,prop3:'hfd'};");
        test("o = {['x']: async function(x) { return await x + 1; }};", 'o = {x:async function (x) { return await x + 1; }};');
        test("o = {['x']: function*(x) {}};", 'o = {x: function*(x) {}};');
        test("o = {['x']: async function*(x) { return await x + 1; }};", 'o = {x:async function*(x) { return await x + 1; }};');
        test("class C {'x' = 0;  ['y'] = 1;}", 'class C { x= 0;y= 1;}');
        test("class C {'m'() {} }", 'class C {m() {}}');
        test("const o = {'b'() {}, ['c']() {}};", 'const o = {b() {}, c(){}};');
        test("o = {['x']: () => this};", 'o = {x: () => this};');
        test("const o = {get ['d']() {}};", 'const o = {get d() {}};');
        test("const o = { set ['e'](x) {}};", 'const o = { set e(x) {}};');
        test("class C {'m'() {}  ['n']() {} 'x' = 0;  ['y'] = 1;}", 'class C {m() {}  n() {} x= 0;y= 1;}');
        test("const o = { get ['d']() {},  set ['e'](x) {}};", 'const o = {get d() {},  set e(x){}};');
        test(
            "const o = {['a']: 1,'b'() {}, ['c']() {},  get ['d']() {},  set ['e'](x) {}};",
            'const o = {a: 1,b() {}, c() {},  get d() {},  set e(x) {}};',
        );
        test(
            `
                class C {
                'm'(){}
                ['n'](){}
                static 'x' = 0;
                static ['y'] = 1;}
            `,
            `
                class C {
                m(){}
                n(){}
                static x = 0;
                static y= 1;}
            `,
        );
        test(
            `
                window['MyClass'] = class {
                static ['Register'](){}
                };
            `,
            `
                window.MyClass = class {
                static Register(){}
                };
            `,
        );
        test(
            `
                class C {
                'method'(){}
                async ['method1'](){}
                *['method2'](){}
                static ['smethod'](){}
                static async ['smethod1'](){}
                static *['smethod2'](){}}
            `,
            `
                class C {
                method(){}
                async method1(){}
                *method2(){}
                static smethod(){}
                static async smethod1(){}
                static *smethod2(){}}
            `,
        );
        test('const test1 = {[0]:87};', 'const test1 = {0:87}');
        test("const test1 = {['default']:87};", 'const test1 = {default:87};');
    });

    it.skip('test_convert_to_dotted_properties_computed_property_with_default_value: needs substitute_binding_property (substitute-alternate-syntax)', () => {
        test("const {['o']: o = 0} = {};", 'const {o:o = 0} = {};');
    });

    it('test_convert_to_dotted_properties_continue_optional_chaining', () => {
        test("const opt1 = window?.a?.['b'];", 'const opt1 = window?.a?.b;');

        test("const opt2 = window?.a['b'];", 'const opt2 = window?.a.b;');
        test(
            `
                const chain =
                window['a'].x.y.b.x.y['c'].x.y?.d.x.y['e'].x.y
                ['f-f'].x.y?.['g-g'].x.y?.['h'].x.y['i'].x.y;
            `,
            `
                const chain = window.a.x.y.b.x.y.c.x.y?.d.x.y.e.x.y
                ['f-f'].x.y?.['g-g'].x.y?.h.x.y.i.x.y;
            `,
        );
    });

    it('test_index', () => {
        test("x['y']", 'x.y;');
        testSame("x['y z']");
        test("x?.['y']", 'x?.y;');
        testSame("x?.['y z']");
        test("x?.['y']()", 'x?.y();');
        testSame("x?.['y z']()");
        test("x['y' + 'z']", 'x.yz');
        test("x?.['y' + 'z']", 'x?.yz');
        test("x['0']", 'x[0];');
        test("x['123']", 'x[123];');
        test("x['-123']", 'x[-123];');
        testSame("x['-0']");
        testSame("x['+0']");
        testSame("x['01']");
        testSame("x['-01']");
        testSame("x['0x1']");
        testSame("x['-0x1']");
        test("x['2147483647']", 'x[2147483647]');
        testSame("x['2147483648']");
        test("x['-2147483648']", 'x[-2147483648]');
        testSame("x['-2147483649']");
    });
});
