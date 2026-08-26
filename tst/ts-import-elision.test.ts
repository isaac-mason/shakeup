import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';

// KNOWN GAP — `bundle()` does not elide a named import whose binding has no VALUE references.
//
// TypeScript lets you write `import { makeNode, Node } from './lib'` with no `type` marker, and tsc
// (without `verbatimModuleSyntax`), rolldown and oxc all elide the specifier when nothing uses it as a
// value. shakeup drops a specifier only when it carries an EXPLICIT `type` marker
// (`strip-ts.ts` `stripImport`, `scan.ts` `extractRecords`), so the specifier survives into
// `namedImports`, `matchImport` finds no value export to bind it to, and `link.ts` reports:
//
//     'Node' is not exported by '/lib.ts' (imported by '/a.ts')
//
// The `it.fails` cases below assert the CORRECT behaviour and therefore currently fail; they are
// marked so the suite stays green while the gap is open. Fixing the gap turns them red — flip them to
// plain `it` at that point. The plain `it` cases already pass and guard the surrounding behaviour.
const LIB = [
    'export function makeNode() { return 1; }',
    'export function other() { return 2; }',
    'export type Node = { id: number };',
    'export interface Shape { n: number }',
].join('\n');

const build = async (main: string) => bundle({ entry: '/a.ts', fs: createMemoryFs({ '/a.ts': main, '/lib.ts': LIB }), external: [] });

describe('type-only named imports are elided without an explicit marker', () => {
    it.fails('a specifier used only in a type annotation', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nlet n: Node;\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/\bNode\b/);
    });

    it.fails('a specifier used only in a function signature', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nexport function f(x: Node): Node { return x; }\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    it.fails('a specifier used only as a generic argument', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nlet a: Array<Node> = [];\nexport const v = makeNode() + a.length;");
        expect(r.errors).toEqual([]);
    });

    it.fails('an interface specifier used only in a type annotation', async () => {
        const r = await build("import { makeNode, Shape } from './lib';\nlet s: Shape;\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    it.fails('a specifier that is never used at all', async () => {
        // Not specific to annotations — the binding simply has no value references. Note this case
        // also covers a typo'd import of a name the target does not export, which stops being an
        // error once unreferenced specifiers are elided (tsc/rolldown/oxc behave the same way).
        const r = await build("import { makeNode, Node } from './lib';\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    // ── already correct: guards against regressing the surrounding behaviour ──

    it('an explicit `type` marker is elided', async () => {
        const r = await build("import { makeNode, type Node } from './lib';\nlet n: Node;\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/\bNode\b/);
    });

    it('an unused specifier of a real VALUE export still resolves', async () => {
        // Proof the gap is about there being no value export to match, not about elision alone.
        const r = await build("import { makeNode, other } from './lib';\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    it('a name used as BOTH a value and a type is kept', async () => {
        const r = await build("import { makeNode, other } from './lib';\nlet o: typeof other;\nexport const v = makeNode() + other();");
        expect(r.errors).toEqual([]);
        expect(r.code).toMatch(/\bother\b/);
    });
});
