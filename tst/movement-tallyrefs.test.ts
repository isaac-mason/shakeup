import { describe, expect, it } from 'vitest';
import { tallyRefs } from '../src/analysis/movement.ts';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';

/** Parse + analyze a snippet, then tally read/write refs and return counts keyed by the DECLARED
 *  name of each symbol (so the test can assert without knowing sym ids). */
function counts(src: string): Map<string, { reads: number; writes: number }> {
    const { program } = parse(src, { ts: false, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const bySym = tallyRefs(program);
    const out = new Map<string, { reads: number; writes: number }>();
    for (const [sym, c] of bySym) {
        const decl = sem.symbols[sym]?.decl;
        if (decl?.name) out.set(decl.name, c);
    }
    return out;
}

describe('tallyRefs — read/write split', () => {
    it('counts plain reads', () => {
        const c = counts('let x = 1; f(x); g(x, x);');
        expect(c.get('x')).toEqual({ reads: 3, writes: 0 });
    });

    it('classifies a simple assignment target as a write, not a read', () => {
        const c = counts('let x = 0; x = 5;');
        expect(c.get('x')).toEqual({ reads: 0, writes: 1 });
    });

    it('a compound assignment (`x += 1`) is BOTH a read and a write', () => {
        const c = counts('let x = 0; x += 1;');
        expect(c.get('x')).toEqual({ reads: 1, writes: 1 });
    });

    it('an update expression (`x++`) is both a read and a write', () => {
        const c = counts('let x = 0; x++;');
        expect(c.get('x')).toEqual({ reads: 1, writes: 1 });
    });

    it('a for-of/in binding target is a write', () => {
        const c = counts('let x; for (x of [1, 2]) {} for (x in {}) {}');
        expect(c.get('x')).toEqual({ reads: 0, writes: 2 });
    });

    it('a destructuring-assignment target counts as a write (never under-counted)', () => {
        const c = counts('let x = 0, y = 0; [x] = [1]; ({ y } = { y: 2 });');
        expect(c.get('x')).toEqual({ reads: 0, writes: 1 });
        expect(c.get('y')).toEqual({ reads: 0, writes: 1 });
    });

    it('a member-assignment reads the object, does not write the binding', () => {
        // `a.b = c` — `a` is READ (to get the object), `c` is read; no binding write of `a`.
        const c = counts('let a = {}, c = 1; a.b = c;');
        expect(c.get('a')).toEqual({ reads: 1, writes: 0 });
        expect(c.get('c')).toEqual({ reads: 1, writes: 0 });
    });
});
