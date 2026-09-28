import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { setVerifyExtras, verifySemantic } from '../src/analysis/ref-facts.ts';
import { parseProgram } from '../src/parser/index.ts';
import { eliminateDeadCode } from '../src/passes/dce/compressor.ts';
import { rolldownDceOptions } from '../src/passes/dce/options.ts';
import { scalarReplaceAggregates } from '../src/passes/optimize/sroa.ts';

// SROA MAINTAINS the semantic rather than rebuilding it, so every scalar it mints has to be a real
// binding and every rewritten member read has to be booked against the right one.
//
// The shape that broke it: two buffers with the SAME NAME in different scopes. Both mint `_m_0`, and
// the minted-symbol table was keyed by NAME, so the second declaration overwrote the first and every
// reference in the first function was stamped with the second's symbol — "reads maintained=7
// truth=10 UNDER(unsafe)", the direction where a live binding looks dead and `dropUnused` is entitled
// to delete a declaration still in use. crashcat hits it exactly: `contact-constraints.ts` declares a
// module-scope `_linearVelocityA` and a function-local one of the same name.
setVerifyExtras(true);

function problems(src: string): string[] {
    const program = parseProgram(src, { ts: false, jsx: false }) as never;
    const semantic = createSemantic();
    analyze(semantic, program);
    scalarReplaceAggregates(program, semantic, src);
    const first = verifySemantic(semantic, program);
    if (first.length > 0) return first;
    eliminateDeadCode(program, semantic, rolldownDceOptions(), 'module');
    return verifySemantic(semantic, program);
}

describe('SROA keeps the maintained semantic honest', () => {
    const SAME_NAME_TWO_SCOPES = `/* @optimize */
function f(a) {
    const _m = [0, 0];
    _m[0] = a;
    _m[1] = a * 2;
    return _m[0] + _m[1] + _m[0] + _m[1];
}

/* @optimize */
function g(b) {
    const _m = [0, 0];
    _m[0] = b * 3;
    _m[1] = b * 4;
    return _m[0] + _m[1] + _m[0];
}

globalThis.out = [f(1), g(2)];`;

    it('books each scalar against its own binding when two scopes use the same buffer name', () => {
        expect(problems(SAME_NAME_TWO_SCOPES)).toEqual([]);
    });

    it('does the same for a module-scope buffer shadowed by a local of the same name', () => {
        const src = `const _m = [0, 0];

/* @optimize */
function f(a) {
    _m[0] = a;
    _m[1] = a * 2;
    return _m[0] + _m[1] + _m[0];
}

/* @optimize */
function g(b) {
    const _m = [0, 0];
    _m[0] = b * 3;
    _m[1] = b * 4;
    return _m[0] + _m[1] + _m[1];
}

globalThis.out = [f(1), g(2)];`;
        expect(problems(src)).toEqual([]);
    });

    // SOURCE ORDER. The scalars' symbols used to be minted when the DECLARATION was visited, so a
    // function written above the buffer it uses had its member reads rewritten first, against a symbol
    // that did not exist yet — every one booked as unbound. The tree was right and the table was
    // short, which is the direction where `dropUnused` may delete a declaration still in use.
    it('books reads from a function declared above the buffer', () => {
        const src = `/* @optimize */
function f(a) {
    _m[0] = a;
    _m[1] = a * 2;
    return _m[0] + _m[1] + _m[0];
}

const _m = [0, 0];

globalThis.out = f(3);`;
        expect(problems(src)).toEqual([]);
    });

    // A COMPOUND assignment is one use that is BOTH a read and a write. The replacement books a read,
    // and the write-reclassification turned that read into a write — correct for `=`, wrong for `+=`,
    // which loses the read. Every accumulator field in a solver is written this way, which is why
    // crashcat's `_linearVelocityA_*` came out three reads short of the truth.
    it('counts a compound assignment as both a read and a write', () => {
        const src = `const _acc = [0, 0];

/* @optimize */
function f(xs) {
    _acc[0] = 0;
    _acc[1] = 0;
    for (let i = 0; i < xs.length; i++) {
        _acc[0] += xs[i];
        _acc[1] -= xs[i];
    }
    return _acc[0] + _acc[1];
}

globalThis.out = f([1, 2, 3]);`;
        expect(problems(src)).toEqual([]);
    });
});
