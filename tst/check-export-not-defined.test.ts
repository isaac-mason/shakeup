import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parseWithDiagnostics } from '../src/parser/parser.ts';

// `export { X }` names a LOCAL binding of this module, so an unresolved one is an early error even
// when the name is a global: `export { Number }` is "Export 'Number' is not defined", not a re-export
// of the intrinsic. oxc reports it from its CHECKER, which is where this goes too — and shakeup's own
// LINK stage already rejects the same thing for a bundle, so this is that rule for a module checked
// on its own. Verified against `oxc-parser` (with `showSemanticErrors`) on 13 shapes.
const check = (src: string, isModule = true): boolean => {
    const p = parseWithDiagnostics(src, { ts: false, jsx: false, kind: isModule ? 'module' : 'unambiguous' });
    if (p.errors.length > 0) return false;
    const sem = createSemantic();
    analyze(sem, p.program, isModule, true);
    return sem.errors.length === 0;
};

describe('an exported name must be defined', () => {
    it('rejects an export of an undeclared name', () => {
        expect(check('export { unresolvable };')).toBe(false);
        expect(check('export { a, b }; var a;'), 'the second one is undefined').toBe(false);
    });

    it('rejects an export of a GLOBAL — it is not a local binding', () => {
        expect(check('export { Number };')).toBe(false);
    });

    it('names the export in the message', () => {
        const p = parseWithDiagnostics('export { unresolvable };', { ts: false, jsx: false, kind: 'module' });
        const sem = createSemantic();
        analyze(sem, p.program, true, true);
        expect(sem.errors[0].msg).toBe("Export 'unresolvable' is not defined");
    });

    it('accepts every form that DOES bind', () => {
        for (const src of [
            'var a; export { a };',
            'export { x as y }; let x;', // hoisting: the declaration may come after
            'function f(){} export { f };',
            'class K {} export { K };',
            'import { z } from "m"; export { z };',
            'export const c = 1;',
            'export default 1;',
        ])
            expect(check(src), src).toBe(true);
    });

    it('does not fire for a RE-EXPORT, which names the other module surface', () => {
        for (const src of ['export { a } from "m";', 'export * from "m";', 'export * as ns from "m";'])
            expect(check(src), src).toBe(true);
    });

    it('does not fire for an ordinary unresolved reference', () => {
        // Only a reference flagged as EXPORTED counts. A plain global in a module is fine, and so is
        // any other unresolved name — without that test every free variable would become an
        // "Export ... is not defined".
        expect(check('Number;'), 'a global read in a module').toBe(true);
        expect(check('foo();'), 'an unresolved call in a module').toBe(true);
        expect(check('var a; export { a }; Number;'), 'both together').toBe(true);
    });

    it('does not fire when the caller analyses the program as a SCRIPT', () => {
        // `analyze`'s `isModule` argument is the caller's declaration of the goal. Told it is a
        // script, the export bindings are not exports and the rule must stay silent.
        const p = parseWithDiagnostics('export { unresolvable };', { ts: false, jsx: false, kind: 'module' });
        const sem = createSemantic();
        analyze(sem, p.program, false, true);
        expect(sem.errors).toHaveLength(0);
    });
});
