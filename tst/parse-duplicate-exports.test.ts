import { describe, expect, it } from 'vitest';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// "It is a Syntax Error if the ExportedNames of ModuleItemList contains any duplicate entries", and
// its sibling rule for `default`. shakeup accepted every form of both.
//
// oxc keeps an `exported_bindings` map on its module record, notes a collision when an insert
// displaces an entry, counts `default` spans across local and indirect export entries, and reports
// from `ModuleRecordBuilder::errors` — which SKIPS the whole check for TypeScript, because
// declaration merging makes duplicates legal there. Verified against `oxc-parser` on every case here.
const parse = (src: string, ts = false) => parseWithDiagnostics(src, { ts, jsx: false, kind: 'module' });
const accepts = (src: string, ts = false): boolean => parse(src, ts).errors.length === 0;

describe('duplicate exports', () => {
    it('rejects a name exported twice, however it is written', () => {
        for (const src of [
            'export const z = 1; export const z = 2;',
            'var x, z; export { x as z }; export { z };',
            'export * as z from "m"; export * as z from "n";',
            'export { x as z, y as z }; var x, y;',
            'export function z(){} export class z{}',
            // A string export name is the SAME name as its bare form — the quotes come off first.
            'export { x as "z" }; export { y as z }; var x, y;',
        ])
            expect(accepts(src), src).toBe(false);
    });

    it('rejects more than one default, however it is written', () => {
        for (const src of [
            'export default 1; export default 2;',
            'export default 1; export { x as default }; var x;',
            'export { default } from "m"; export default 1;',
        ])
            expect(accepts(src), src).toBe(false);
        expect(parse('export default 1; export default 2;').errors[0].msg).toBe('A module cannot have multiple default exports.');
    });

    it("uses oxc's wording and names the offending export", () => {
        const r = parse('export const z = 1; export const z = 2;');
        expect(r.errors[0].msg).toBe("Duplicated export 'z'");
    });

    it('accepts what is genuinely distinct', () => {
        for (const src of [
            'export const a = 1; export const b = 2;',
            'export * from "m"; export * from "n";', // star names are unknown until link time
            'export { x } from "m"; export { y } from "n"; var x, y;',
            'export const { a, b } = o; export const [c, ...d] = o;',
            'var x; export { x }; export { x as y };', // one LOCAL, two export names
            'export {}; export {};',
            'export const a = 1; { const a = 2; }', // a nested binding is not an export
            'export default function f(){}',
        ])
            expect(accepts(src), src).toBe(true);
    });

    it('is skipped entirely for TypeScript, as oxc skips it', () => {
        // Declaration merging makes duplicates legal in TS, so the rule does not apply there.
        expect(accepts('export const z = 1; export const z = 2;', true), 'ts').toBe(true);
        expect(accepts('export default 1; export default 2;', true), 'ts').toBe(true);
    });
});
