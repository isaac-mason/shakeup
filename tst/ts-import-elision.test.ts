import { describe, expect, it } from 'vitest';
import { bundle } from '../src/bundle.ts';
import { createMemoryFs } from '../src/fs.ts';
import type { Plugin } from '../src/plugin.ts';

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
// FIXED. The elision now runs in `scan.ts` (`elideUnreferencedImports`) AFTER the lowering traversal
// has erased type annotations and `applyRefDelta` has folded in the resulting reference counts, and
// BEFORE `extractRecords` turns surviving specifiers into import records. Checking inside `tsStrip`
// itself would read counts that are still stale, since the delta is applied after the traversal.
//
// Scoped to TypeScript modules: in JavaScript an imported name that does not exist is a genuine
// error and must keep being reported, because no erasure could have removed it.
const LIB = [
    'export function makeNode() { return 1; }',
    'export function other() { return 2; }',
    'export type Node = { id: number };',
    'export interface Shape { n: number }',
].join('\n');

const build = async (main: string) => bundle({ entry: '/a.ts', fs: createMemoryFs({ '/a.ts': main, '/lib.ts': LIB }), external: [] });

describe('type-only named imports are elided without an explicit marker', () => {
    it('a specifier used only in a type annotation', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nlet n: Node;\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
        expect(r.code).not.toMatch(/\bNode\b/);
    });

    it('a specifier used only in a function signature', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nexport function f(x: Node): Node { return x; }\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    it('a specifier used only as a generic argument', async () => {
        const r = await build("import { makeNode, Node } from './lib';\nlet a: Array<Node> = [];\nexport const v = makeNode() + a.length;");
        expect(r.errors).toEqual([]);
    });

    it('an interface specifier used only in a type annotation', async () => {
        const r = await build("import { makeNode, Shape } from './lib';\nlet s: Shape;\nexport const v = makeNode();");
        expect(r.errors).toEqual([]);
    });

    it('a specifier that is never used at all', async () => {
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

// Constraints discovered while implementing the elision — each one broke a real test first, so they
// are the reason it lives where it does (after resolution, in `elideTypeOnlyImports`) rather than in
// `tsStrip` or `extractRecords`.
describe('import elision leaves externals and JavaScript alone', () => {
    const buildWith = async (files: Record<string, string>, external: string[] = [], plugins: Plugin[] = []) =>
        bundle({ entry: Object.keys(files)[0], fs: createMemoryFs(files), external, plugins });

    it('keeps every specifier of an unreferenced EXTERNAL import', async () => {
        // An external's import line is rebuilt from `linked.externalLocals`, and whether an
        // unreferenced one survives is decided later by `pruneUnusedExternals` via symbol liveness —
        // which needs the binding to still exist. Eliding collapsed `import { a } from 'ext'` to a
        // bare `import 'ext'`, which reads as side-effectful and could then never be pruned.
        const { code } = await buildWith({ '/main.ts': "import { a, b } from 'ext';\nexport const out = 1;" }, ['ext']);
        expect(code).toMatch(/from\s*['"]ext['"]/);
    });

    it('still drops a side-effect-free external that a PLUGIN declared', async () => {
        // Externality is not knowable during scan: a plugin can declare it from `resolveId`, which
        // runs after the importing module has been scanned. That is why the elision cannot live in
        // the scan pass, and why this case regressed when it did.
        const plugin: Plugin = {
            name: 'ext-side-effects',
            resolveId: (_ctx, spec) => (spec === 'clean-lib' ? { id: 'clean-lib', external: true, moduleSideEffects: false } : null),
        };
        const { code } = await buildWith({ '/main.ts': "import { a } from 'clean-lib';\nexport const out = 1;" }, [], [plugin]);
        expect(code).not.toContain('clean-lib');
    });

    it('still reports a missing name in a JavaScript module', async () => {
        // No erasure could have removed it, so it is a genuine error and must keep being reported.
        const r = await buildWith({ '/main.js': "import { a, nope } from './lib.js';\nexport const x = a;", '/lib.js': 'export const a = 1;' });
        expect(r.errors.join('\n')).toMatch(/'nope' is not exported/);
    });

    it('keeps a bare side-effect import', async () => {
        const r = await buildWith({ '/main.ts': "import './s';\nexport const x = globalThis.__hit;", '/s.ts': 'globalThis.__hit = 1;' });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('__hit = 1');
    });
});
