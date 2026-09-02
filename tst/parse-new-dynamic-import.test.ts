// `new import('m')` has no valid parse. The grammar is `NewExpression : new MemberExpression
// Arguments?`, and `import('m')` is an `ImportCall` — a CallExpression, never a MemberExpression. So
// neither `new import('m')` nor `new import('m').prop` can be derived, and test262 files both under
// `dynamic-import/syntax/invalid/`.
//
// **node is NOT the oracle here, and that is deliberate.** V8 rejects `new import('m')` but ACCEPTS
// `new import('m').prop`, which test262 and oxc both reject. Where node has been the oracle before —
// `with` in a module, `await` in a class static block — it was because oxc had made a policy call the
// language did not support. This is the reverse: the spec grammar is explicit and test262 asserts it
// directly (`nested-else-braceless-no-new-call-expression-prop-access.js`, phase: parse), so the
// fixtures below are checked against test262's verdict rather than node's.
//
// oxc: `is_import_expression_or_member_access_on_import_expression` (`js/expression.rs:26`) walks the
// callee through member accesses, tagged templates and non-null assertions, guarded by an `is_import`
// captured from the token that OPENS the callee (`js/expression.rs:1009`) — which is why wrapping in
// parentheses is the fix oxc's own help text suggests.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;

describe('new may not be applied to a dynamic import', () => {
    it.each([
        'new import("m");',
        'new import("m")();',
        'new import("m").prop;',
        'new import("m").a.b;',
        'new import("m")[0];',
        'new import("m")`t`;',
        'if (false) {} else new import("m").prop;',
        'let f = () => new import("m").prop;',
    ])('%s', (src) => {
        expect(errs(src), src).not.toEqual([]);
        expect(errs(src)[0].msg).toBe('Cannot use new with dynamic import');
    });
});

describe('what stays legal', () => {
    // Parenthesising is the documented fix: the callee no longer OPENS with `import`, so the guard
    // never arms. `new import.meta` is legal for the same reason it is not an ImportExpression.
    it.each(['new (import("m"));', 'new (import("m")).prop;', 'new import.meta;', 'import("m");', 'import("m").then(f);'])(
        '%s',
        (src) => {
            expect(errs(src), src).toEqual([]);
        },
    );

    it('an ordinary new expression is untouched', () => {
        expect(errs('new Foo(); new Foo.Bar(); new a.b.c();')).toEqual([]);
    });
});
