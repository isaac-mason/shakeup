import { describe, expect, it } from 'vitest';
import { N } from '../src/ast/index.ts';
import { bundle } from '../src/bundler/bundle.ts';
import { parse } from '../src/parser/index.ts';

// `export type * from './m'` and `export type * as ns from './m'` — TypeScript 5.0 type-only
// re-export syntax. oxc accepts both; shakeup did not, and the gap was found by DOGFOODING: the
// curated `src/index.ts` uses `export type *` to publish types without values, and
// `tst/dev-transform.corpus.test.ts` (which runs devTransform over shakeup's own src/) failed on it.
//
// The parse was only half of it. The `type` keyword sits BEFORE the `*`, so the lookahead has to run
// ahead of the star branch — and `ExportAllDeclaration` had no `exportKind` field at all, unlike
// `ExportNamedDeclaration`, so there was nowhere to record type-only-ness even once parsed. Accepting
// the syntax without that field would have been worse than rejecting it: the statement parses, then
// erases nowhere, and the target module gets BUNDLED by a statement with no runtime meaning.

const first = (src: string) => {
    const r = parse(src, { ts: true, jsx: false, kind: 'module' });
    expect(r.errors).toEqual([]);
    return r.program.data.body[0] as { type: number; data: { exportKind: string } };
};

describe('parsing', () => {
    it.each([
        ['export type * from', "export type * from './x.ts';", 'type'],
        ['export type * as ns from', "export type * as ns from './x.ts';", 'type'],
        ['plain export *', "export * from './x.ts';", 'value'],
        ['plain export * as ns', "export * as ns from './x.ts';", 'value'],
    ])('%s records exportKind=%#', (_label, src, kind) => {
        const n = first(src);
        expect(n.type).toBe(N.ExportAllDeclaration);
        expect(n.data.exportKind).toBe(kind);
    });

    it('still parses `export type Foo = …`, which is an alias, not a modifier', () => {
        // The regression this guards: the lookahead consumes `type`, and when what follows is neither
        // `{` nor `*` it MUST restore. Getting that wrong breaks every type alias in the codebase.
        expect(parse('export type Foo = number;', { ts: true, jsx: false, kind: 'module' }).errors).toEqual([]);
    });
});

describe('erasure — the statement has no runtime meaning', () => {
    const build = (main: string) => {
        const files: Record<string, string> = {
            '/types.ts': 'export type Foo = number;\nglobalThis.SIDE_EFFECT = true;\nexport const runtimeVal = 1;\n',
            '/main.ts': main,
        };
        return bundle({ entry: '/main.ts', fs: { read: (i) => files[i] ?? null, exists: (i) => i in files }, external: [] });
    };

    it('does not bundle the target, run its side effects, or re-export its values', async () => {
        const r = await build("export type * from './types.ts';\nexport const x = 1;\n");
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].moduleIds).toEqual(['/main.ts']);
        expect(r.code).not.toMatch(/SIDE_EFFECT/);
        expect(r.code).not.toMatch(/runtimeVal/);
    });

    it('but a VALUE `export *` still does all three', async () => {
        // The negative control. Without it, a pass that dropped every `export *` would pass above.
        const r = await build("export * from './types.ts';\nexport const x = 1;\n");
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].moduleIds).toContain('/types.ts');
        expect(r.code).toMatch(/SIDE_EFFECT/);
        expect(r.code).toMatch(/runtimeVal/);
    });

    it('the type-only namespace form erases too', async () => {
        const r = await build("export type * as ns from './types.ts';\nexport const x = 1;\n");
        expect(r.errors).toEqual([]);
        expect(r.chunks[0].moduleIds).toEqual(['/main.ts']);
        expect(r.code).not.toMatch(/SIDE_EFFECT/);
    });
});
