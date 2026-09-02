// The destructuring-pattern half of the rest rules — the parameter half is in
// `parse-rest-parameter.test.ts`. oxc drives both from ONE list parser,
// `parse_delimited_list_with_rest_into` (`cursor.rs:566`), which is why the two sets are the same
// three rules with two of the messages shared:
//
//   · nothing may follow the rest element  — `binding_rest_element_last` / `rest_parameter_last`
//   · not even a trailing comma            — `rest_element_trailing_comma`, shared verbatim
//   · an OBJECT rest target must be a plain identifier — `invalid_binding_rest_element`
//
// The third is object-only on purpose: oxc checks it in `parse_object_binding_pattern` and not in
// `parse_array_binding_pattern` (`js/binding.rs:53-59`), because `[...[a]] = x` is legal and
// `{...[a]} = x` is not. node agrees on both, which is what the fixtures below assert.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const rejects = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is invalid`).toThrow();
    expect(parse(src, { ts: false, jsx: false }).errors, src).not.toEqual([]);
};

const accepts = (src: string) => {
    expect(() => new Function(src), `node must agree ${src} is valid`).not.toThrow();
    expect(parse(src, { ts: false, jsx: false }).errors, src).toEqual([]);
};

describe('nothing may follow a rest element', () => {
    it.each([
        'const [...a, b] = x;',
        'const [...a,] = x;',
        'const {...a, b} = x;',
        'const {...a,} = x;',
        'let [...a, b] = x;',
        'var {...a, b} = x;',
        'function f([...a, b]) {}',
        'function f({...a, b}) {}',
        'try {} catch ([...a, b]) {}',
        'try {} catch ({...a, b}) {}',
        'for (const [...a, b] of x) {}',
        'for (const {...a, b} in x) {}',
        '([...a, b]) => {};',
        '({...a, b}) => {};',
    ])('%s', rejects);

    it('the message distinguishes a trailing comma from a following element', () => {
        const msg = (src: string) => parse(src, { ts: false, jsx: false }).errors[0].msg;
        expect(msg('const [...a,] = x;')).toMatch(/trailing comma/);
        expect(msg('const [...a, b] = x;')).toMatch(/must be last in a destructuring pattern/);
        expect(msg('const {...a,} = x;')).toMatch(/trailing comma/);
        expect(msg('const {...a, b} = x;')).toMatch(/must be last in a destructuring pattern/);
    });
});

describe('an object rest target must be a plain identifier', () => {
    it.each(['const {...[a]} = x;', 'const {...{a}} = x;', 'function f({...[a]}) {}', 'function f({...{a}}) {}'])(
        '%s',
        rejects,
    );

    it('an ARRAY rest target may be a pattern — the rule is object-only', () => {
        accepts('const [...[a]] = x;');
        accepts('const [...{a}] = x;');
        accepts('function f([...[a]]) {}');
    });

    // `{...[a]}` is invalid as a binding AND as an assignment target, but they are two rules in two
    // places — oxc's `invalid_binding_rest_element` vs `invalid_rest_assignment_target` — and the
    // messages differ. An assignment target may be a member expression (`{...a.b} = x`); a binding
    // may not. Both halves are asserted so a future merge of the two cannot pass silently.
    it('names the pattern, not the assignment — the two diagnostics are distinct in oxc', () => {
        const msg = (src: string) => parse(src, { ts: false, jsx: false }).errors[0].msg;
        expect(msg('const {...[a]} = x;')).toMatch(/destructuring pattern/);
        expect(msg('({...[a]} = x);')).toMatch(/destructuring assignment/);
        accepts('({...a.b} = x);');
    });
});

describe('what stays legal', () => {
    it.each([
        'const [...a] = x;',
        'const [a, ...b] = x;',
        'const [a,] = x;',
        'const {...a} = x;',
        'const {a, ...b} = x;',
        'const {a,} = x;',
        'const [, ...a] = x;',
    ])('%s', accepts);

    it('an ambient declaration is exempt from the position rules, as in oxc', () => {
        expect(parse('declare function g({ ...a, }: T): void;', { ts: true, jsx: false }).errors).toEqual([]);
    });
});
