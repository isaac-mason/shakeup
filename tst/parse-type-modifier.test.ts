// The `type` modifier on imports and exports. `type` is CONTEXTUAL, so every form is ambiguous with a
// binding actually named `type`, and the only way through is counting tokens — which is why oxc has a
// dedicated table for it (`js/module.rs:826-901` and `:1025-1047`).
//
// We had approximated both tables and rejected five valid shapes. These are false-REJECTS: the
// harmful direction, where a real file fails to build. Confirmed valid by BOTH oxc and esbuild before
// being treated as bugs. Found by the N3 sweep of oxc's lookahead sites.
import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

const errs = (src: string) => parse(src, { ts: true, jsx: false }).errors;

/** `local -> exported : kind` for the single specifier in `src`. */
function spec(src: string): string {
    const r = parse(src, { ts: true, jsx: false });
    let found: Node | null = null;
    walk(r.program as Node, (n) => {
        if (n.type === N.ImportSpecifier || n.type === N.ExportSpecifier) found = n;
    });
    const d = (found as unknown as { data: Record<string, { name?: string }> }).data;
    const kind = (d as unknown as { importKind?: string; exportKind?: string });
    const a = d.local?.name ?? '?';
    const b = (d.imported ?? d.exported)?.name ?? '?';
    return `${a}->${b}:${kind.importKind ?? kind.exportKind}`;
}

describe('`type` on the import/export declaration', () => {
    it.each([
        'import type {A} from "m";',
        'import type * as N from "m";',
        'import type A from "m";',
        'import type from "m";', // a DEFAULT import bound to the name `type`
        'import type from from "m";', // type-only default import bound to `from`
        'import type, {A} from "m";', // default `type`, plus named imports
        'import type type from "m";',
        'import type A = require("m");',
    ])('accepts %s', (src) => {
        expect(errs(src), src).toEqual([]);
    });
});

describe('`type` inside a specifier list — the `as` chain', () => {
    // Each extra `as` flips the reading. Verified node-for-node against oxc.
    it.each([
        ['import {type A} from "m";', 'A->A:type'],
        ['import {type as} from "m";', 'as->as:type'], // type-only import of `as`
        ['import {type as as} from "m";', 'as->type:value'], // `type` itself, renamed to `as`
        ['import {type as as as} from "m";', 'as->as:type'], // type-only `as`, renamed to `as`
        ['import {type A as B} from "m";', 'B->A:type'],
        ['import {type as B} from "m";', 'B->type:value'], // `type` renamed to B
        ['import {type} from "m";', 'type->type:value'],
    ])('%s is %s', (src, shape) => {
        expect(errs(src), src).toEqual([]);
        expect(spec(src), src).toBe(shape);
    });

    it.each([
        ['export {type A} from "m";', 'A->A:type'],
        ['export {type as} from "m";', 'as->as:type'],
        ['export {type as as} from "m";', 'type->as:value'],
        ['export {type as as as} from "m";', 'as->as:type'],
        ['export {type as B} from "m";', 'type->B:value'],
        ['export {type} from "m";', 'type->type:value'],
    ])('%s is %s', (src, shape) => {
        expect(errs(src), src).toEqual([]);
        expect(spec(src), src).toBe(shape);
    });

    // Arbitrary module namespace names must survive the rewrite — they share the same code path.
    it.each(['export {a as "x y"};', 'export {"a-b" as c} from "m";', 'export {"a-b"} from "m";', 'import {"a-b" as c} from "m";'])(
        'still accepts %s',
        (src) => {
            expect(errs(src), src).toEqual([]);
        },
    );
});
