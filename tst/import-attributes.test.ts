import { describe, expect, it } from 'vitest';
import { N } from '../src/ast.ts';
import { parse } from '../src/parser/index.ts';

// P1 step 2 of the alignment plan: the import-attributes clause — `with { type: "json" }`, and the
// older `assert { … }` spelling that is still widely shipped (36 of the failing rspack files use it).
//
// The grammar surface was taken from `oxc-parser` rather than from the proposal text: every form
// below was confirmed accepted by oxc first, then implemented. That is why the empty clause, the
// string-literal key and the line break are here — none of them was obvious.
//
// Attaching to `ExportAllDeclaration` needed care: the clause must be parsed BEFORE `consumeSemi`,
// and getting that wrong on the `export … from` path made only that one form fail.
const errs = (src: string) => parse(src, { ts: false, jsx: false, kind: 'module' }).errors;
const first = (src: string) => parse(src, { ts: false, jsx: false, kind: 'module' }).program.data.body[0];

describe('import attributes', () => {
    it.each([
        ['a default import', 'import x from "./a.json" with { type: "json" };'],
        ['the legacy `assert` spelling', 'import x from "./a.json" assert { type: "json" };'],
        ['a namespace import', 'import * as x from "./a.json" with { type: "json" };'],
        ['a bare side-effect import', 'import "./a.json" with { type: "json" };'],
        ['a named re-export', 'export { a } from "./a.json" with { type: "json" };'],
        ['an export-star', 'export * from "./a.json" with { type: "json" };'],
        ['an export-star-as', 'export * as ns from "./a.json" with { type: "json" };'],
        ['several attributes', 'import x from "./a" with { type: "json", other: "v" };'],
        ['a string-literal key', 'import x from "./a" with { "type": "json" };'],
        ['an empty clause', 'import x from "./a" with { };'],
        ['a trailing comma', 'import x from "./a" with { type: "json", };'],
        ['a line break before the keyword', 'import x from "./a"\n with { type: "json" };'],
    ])('parses %s', (_label, src) => {
        expect(errs(src)).toEqual([]);
    });

    it('records the attribute on the declaration', () => {
        const d = first('import x from "./a.json" with { type: "json" };').data as {
            attributes: { data: { key: { name: string } } }[];
        };
        expect(d.attributes).toHaveLength(1);
        expect(d.attributes[0].data.key.name).toBe('type');
    });

    it('records attributes on an export-star too', () => {
        const n = first('export * from "./a.json" with { type: "json" };');
        expect(n.type).toBe(N.ExportAllDeclaration);
        expect((n.data as { attributes: unknown[] }).attributes).toHaveLength(1);
    });

    it('leaves a declaration without a clause with an empty list', () => {
        expect((first('import x from "./a.json";').data as { attributes: unknown[] }).attributes).toEqual([]);
    });

    // ── the boundary: `assert` is contextual and `with` starts a statement ──

    it('does not swallow a call to a function named `assert`', () => {
        // `assert` is not a reserved word, so the clause is only taken when a `{` follows — otherwise
        // `import "./a"; assert(x)` would lose its next statement.
        const p = parse('import "./a";\nassert(x);', { ts: false, jsx: false, kind: 'module' });
        expect(p.errors).toEqual([]);
        expect(p.program.data.body).toHaveLength(2);
    });

    it('a bare `assert` identifier on the next line is still a statement', () => {
        const p = parse('import "./a";\nassert;', { ts: false, jsx: false, kind: 'module' });
        expect(p.errors).toEqual([]);
        expect(p.program.data.body).toHaveLength(2);
    });
});
