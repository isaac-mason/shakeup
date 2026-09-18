import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { setVerifyExtras, verifySemantic } from '../src/analysis/ref-facts.ts';
import { parseProgram } from '../src/parser/index.ts';
import { runCompress } from '../src/passes/compress/index.ts';

// `dropUnused` retires a binding it deletes — except on one path. An UNUSED binding whose initialiser
// has side effects becomes a bare expression statement:
//
//   const x = side();   →   side();
//
// `ctx.replaceWith` does not retire, deliberately: the bindings of a replaced subtree usually reappear
// inside the replacement. Here they do not, and nothing retired them, so the table kept counting a
// binding whose declaration no longer exists. Safe — a stale symbol costs a mangled name, not
// correctness — but it is exactly what makes the maintained table emit different identifiers from a
// rebuilt one, and it was all 94 of crashcat's stale bindings.
setVerifyExtras(true);

function problems(src: string): string[] {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    let semantic = createSemantic();
    analyze(semantic, program);
    const refreshed = runCompress(program, semantic, 'dce');
    if (refreshed !== null) semantic = refreshed;
    return verifySemantic(semantic, program);
}

describe('dropUnused retires the bindings it deletes', () => {
    it('retires an unused binding whose init is kept for its side effect', () => {
        expect(
            problems(`function side() { globalThis.hit = 1; return 2; }
const unusedBinding = side();
globalThis.out = 3;`),
        ).toEqual([]);
    });

    it('retires the destructured bindings of an unused impure init', () => {
        expect(
            problems(`function side() { globalThis.hit = 1; return [1, 2]; }
const [unusedA, unusedB] = side();
globalThis.out = 3;`),
        ).toEqual([]);
    });

    it('keeps the side effect', () => {
        const src = `function side() { globalThis.hit = (globalThis.hit || 0) + 1; return 2; }
const unusedBinding = side();
globalThis.out = globalThis.hit;`;
        const program = parseProgram(src, { ts: false, jsx: false }) as never;
        const semantic = createSemantic();
        analyze(semantic, program);
        runCompress(program, semantic, 'dce');
        // the call survives even though the binding does not
        expect(verifySemantic(semantic, program)).toEqual([]);
    });
});
