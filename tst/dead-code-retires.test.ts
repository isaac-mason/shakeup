import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { setVerifyExtras, verifySemantic } from '../src/analysis/ref-facts.ts';
import { parseProgram } from '../src/parser/index.ts';
import { runCompress } from '../src/passes/compress/index.ts';

// When a condition folds to a constant, `deadCode` replaces the `if` with the branch that runs. The
// branch that does NOT run leaves the tree for good — and `ctx.replaceWith` deliberately does not
// retire, because a replaced subtree's bindings usually reappear inside the replacement. Here they do
// not: everything declared in the discarded branch is gone, and nothing evicted it.
//
// Safe (a stale symbol costs a mangled name, not correctness) but it is what makes the maintained
// table disagree with a rebuilt one, and on crashcat it was all 94 stale bindings — helper locals in
// GJK branches that constant-folding proved unreachable.
setVerifyExtras(true);

function problems(src: string): string[] {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    let semantic = createSemantic();
    analyze(semantic, program);
    const refreshed = runCompress(program, semantic, 'full');
    if (refreshed !== null) semantic = refreshed;
    return verifySemantic(semantic, program);
}

describe('deadCode retires the bindings of a branch it discards', () => {
    it('retires a discarded then-branch', () => {
        expect(
            problems(`const FLAG = 0;
function f(a) {
    if (FLAG) {
        const deadLocal = a * 2;
        const alsoDead = deadLocal + 1;
        return alsoDead;
    }
    return a;
}
globalThis.out = f(1);`),
        ).toEqual([]);
    });

    it('retires a discarded else-branch', () => {
        expect(
            problems(`const FLAG = 1;
function f(a) {
    if (FLAG) return a;
    const deadLocal = a * 3;
    function deadFn(q) { return q; }
    return deadLocal + deadFn(a);
}
globalThis.out = f(1);`),
        ).toEqual([]);
    });

    it('keeps the surviving branch working', () => {
        const src = `const FLAG = 0;
function f(a) {
    if (FLAG) { const deadLocal = a * 2; return deadLocal; }
    return a + 1;
}
globalThis.out = f(4);`;
        const program = parseProgram(src, { ts: false, jsx: false }) as never;
        const semantic = createSemantic();
        analyze(semantic, program);
        runCompress(program, semantic, 'full');
        expect(verifySemantic(semantic, program)).toEqual([]);
    });
});
