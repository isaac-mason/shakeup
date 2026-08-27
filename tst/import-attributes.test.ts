import { describe, expect, it } from 'vitest';
import { N } from '../src/ast.ts';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
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

// P1 steps 3a-3c: what the attribute MEANS. Measured on both oracles first (§3b of the plan):
// a BUNDLED module drops the clause — it is inlined JavaScript by then and the attribute would be a
// lie — while an EXTERNAL keeps it, because the runtime still has to fetch it.
describe('import attributes have an effect, not just a parse', () => {
    const build = async (files: Record<string, string>, opts: Record<string, unknown> = {}) =>
        bundle({ entry: '/main.js', external: [], fs: createMemoryFs(files), ...opts });

    const run = async (files: Record<string, string>, opts: Record<string, unknown> = {}) => {
        const r = await build(files, opts);
        expect(r.errors).toEqual([]);
        return (await import(`data:text/javascript,${encodeURIComponent(r.code)}`)) as { x: unknown };
    };

    describe('3a — a bundled dynamic import DROPS the clause', () => {
        it('does not carry `type: json` onto a JavaScript chunk', async () => {
            // The specifier is rewritten to a JS chunk, so keeping the attribute made Node throw
            // `Module "…/d-…js" is not of type "json"` — from a build reporting no errors.
            const r = await build({
                '/d.json': '{"k":1}',
                '/main.js': 'export const x = import("./d.json", { with: { type: "json" } }).then((m) => m.default.k);',
            });
            expect(r.errors).toEqual([]);
            const entry = r.chunks.find((c) => c.isEntry)!.code;
            expect(entry).not.toMatch(/with:\s*\{/);
        });

        it('the same program now runs', async () => {
            const { writeFileSync, mkdtempSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const { pathToFileURL } = await import('node:url');
            const r = await build({
                '/d.json': '{"k":1}',
                '/main.js': 'export const x = import("./d.json", { with: { type: "json" } }).then((m) => m.default.k);',
            });
            const dir = mkdtempSync(join(tmpdir(), 'ia-'));
            writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
            for (const c of r.chunks) writeFileSync(join(dir, c.fileName), c.code);
            const ns = (await import(pathToFileURL(join(dir, r.chunks.find((c) => c.isEntry)!.fileName)).href)) as {
                x: Promise<unknown>;
            };
            expect(await ns.x).toBe(1);
        });
    });

    describe('3b — an EXTERNAL keeps the clause', () => {
        const ext = async (src: string, opts: Record<string, unknown> = {}) =>
            (await bundle({ entry: '/main.js', external: ['ext'], fs: createMemoryFs({ '/main.js': src }), ...opts })).code.split(
                '\n',
            )[0];

        it.each([
            ['a default import', 'import u from "ext" with { type: "json" };\nexport const x = u;'],
            ['a namespace import', 'import * as u from "ext" with { type: "json" };\nexport const x = u;'],
            ['a named import', 'import { a } from "ext" with { type: "json" };\nexport const x = a;'],
            ['a bare side-effect import', 'import "ext" with { type: "json" };\nexport const x = 1;'],
        ])('keeps it on %s', async (_label, src) => {
            expect(await ext(src)).toMatch(/with \{ type: "json" \}/);
        });

        it('normalises the legacy `assert` spelling to `with`', async () => {
            const line = await ext('import u from "ext" assert { type: "json" };\nexport const x = u;');
            expect(line).toMatch(/with \{ type: "json" \}/);
            expect(line).not.toContain('assert');
        });

        it('keeps several attributes, and adds nothing when there are none', async () => {
            expect(await ext('import u from "ext" with { type: "json", a: "b" };\nexport const x = u;')).toMatch(
                /with \{ type: "json", a: "b" \}/,
            );
            expect(await ext('import u from "ext";\nexport const x = u;')).not.toContain('with');
        });

        it('survives minification', async () => {
            expect(
                await ext('import u from "ext" with { type: "json" };\nexport const x = u;', { output: { minify: true } }),
            ).toMatch(/with\{type: "json"\}/);
        });
    });

    describe('3c — `type` overrides the extension', () => {
        it('loads a .txt file as JSON when asked', async () => {
            expect(
                (
                    await run({
                        '/d.txt': '{"k":1}',
                        '/main.js': 'import d from "./d.txt" with { type: "json" };\nexport const x = d.k;',
                    })
                ).x,
            ).toBe(1);
        });

        it('named imports work through the override', async () => {
            expect(
                (
                    await run({
                        '/d.txt': '{"k":2,"n":3}',
                        '/main.js': 'import { n } from "./d.txt" with { type: "json" };\nexport const x = n;',
                    })
                ).x,
            ).toBe(3);
        });

        it('the legacy `assert` spelling overrides too', async () => {
            expect(
                (
                    await run({
                        '/d.txt': '{"k":5}',
                        '/main.js': 'import d from "./d.txt" assert { type: "json" };\nexport const x = d.k;',
                    })
                ).x,
            ).toBe(5);
        });

        it('a .txt with NO attribute is still not JSON', async () => {
            // The override must come from the attribute, not from the loader guessing.
            const r = await build({ '/d.txt': 'hello', '/main.js': 'import d from "./d.txt";\nexport const x = d;' });
            expect(r.errors.length).toBeGreaterThan(0);
        });

        it('a .json file with no attribute still works', async () => {
            expect((await run({ '/d.json': '{"k":4}', '/main.js': 'import d from "./d.json";\nexport const x = d.k;' })).x).toBe(
                4,
            );
        });
    });
});
