// `import.source(x)` and `import.defer(x)` — the expression half of the import-phase proposal, and
// the four early errors that come with the import call itself.
//
// oxc splits this across two functions and shakeup follows the split exactly:
//   · `parse_import_meta_or_call` (`js/expression.rs:676`) — after `import.`, ONLY `meta` is a
//     property. `source` and `defer` are phases, not properties, so each routes straight into the
//     call parser and a bare `import.source` with no `(` is an error. Anything else is
//     `invalid_import_property`.
//   · `parse_import_expression` (`js/module.rs:32`) — no specifier, a spread argument, or more than
//     two arguments are each their own diagnostic.
//
// **node cannot be the oracle for half of this.** node 24 implements `import.source` but NOT
// `import.defer`, so it reports `import.defer('m')` as an unexpected identifier — a parse failure for
// the wrong reason. test262 is the oracle here (`dynamic-import/syntax/invalid/*import-defer*`), and
// the cases node CAN judge are checked against it below as a partial cross-check.
//
// A phase import parses but is refused at build, the split `with` and decorators already got:
// `scan.ts`'s `collectUnsupported`. Lowering it silently would turn a deferred import into an EAGER
// one, which is a semantic change, not a missing feature.
import { describe, expect, it } from 'vitest';
import { N, walk } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: false, jsx: false }).errors;
const msg = (src: string) => errs(src)[0]?.msg;

describe('after `import.`, only meta is a property', () => {
    it.each(['import.UNKNOWN("m");', 'import.foo;', 'import.metaX;', 'import.Meta;'])('%s', (src) => {
        expect(msg(src), src).toBe(
            'The only valid property accesses on import are `import.meta`, `import.source()`, and `import.defer()`',
        );
    });

    it('a phase is not a property — it must be a call', () => {
        expect(msg('import.source;')).toMatch(/expected '\('/);
        expect(msg('import.defer;')).toMatch(/expected '\('/);
    });
});

describe('the import call itself', () => {
    it('requires a specifier', () => {
        for (const src of ['import();', 'import.source();', 'import.defer();']) {
            expect(msg(src), src).toBe('import() requires a specifier.');
        }
    });

    it('refuses a spread argument in either position', () => {
        for (const src of ['import(...a);', 'import("a", ...b);', 'import.defer(...a);']) {
            expect(msg(src), src).toBe('Argument of dynamic import cannot be a spread element.');
        }
    });

    it('accepts at most a specifier and an attributes object', () => {
        expect(msg('import("a", {}, c);')).toBe(
            'Dynamic imports can only accept a module specifier and an optional set of attributes as arguments',
        );
    });
});

describe('what stays legal', () => {
    it.each([
        'import("m");',
        'import("m", {});',
        'import("m",);',
        'import("m", { with: { type: "json" } });',
        'import.meta;',
        'import.meta.url;',
        'import.source("m");',
        'import.defer("m");',
        'import.source("m").then(f);',
    ])('%s', (src) => {
        expect(errs(src), src).toEqual([]);
    });

    // The cases node 24 can judge, as a cross-check on the ones above that it shares. `import.meta`
    // is excluded because `new Function` builds a SCRIPT, where it is invalid for a reason unrelated
    // to this rule; `import.defer` is excluded because node 24 has not implemented it.
    it.each(['import("m");', 'import.source("m");'])('node agrees %s is valid', (src) => {
        expect(() => new Function(`async () => { ${src} }`), src).not.toThrow();
    });
});

describe('the phase reaches the AST and the printer, rather than being dropped', () => {
    it('is carried as a scalar, like ImportDeclaration.phase', () => {
        const phaseOf = (src: string) => {
            let found: unknown = 'not-found';
            walk(parse(src, { ts: false, jsx: false }).program, (n) => {
                if (n.type === N.ImportExpression) found = n.data.phase;
                return true;
            });
            return found;
        };
        expect(phaseOf('import.source("m");')).toBe('source');
        expect(phaseOf('import.defer("m");')).toBe('defer');
        expect(phaseOf('import("m");')).toBe(null);
    });
});
