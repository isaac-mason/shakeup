// Does a FAILED speculative parse leave a trace?
//
// `saveState` rewinds 8 of `ParserState`'s 42 fields. The other 34 are assumed not to matter and
// nothing checked that assumption, so widening speculation in the arrow Tristate port silently
// double-recorded `@__NO_SIDE_EFFECTS__`. That was found by guessing which field would leak. This
// checks the whole observable surface instead of guessing.
//
// Method: parse the same construct twice, once where it sits inside a paren head that speculates and
// FAILS, once inside an array literal that never speculates. `(a, X)` and `[a, X]` are the same
// length, so every recorded OFFSET must match too, not just the counts. Any difference is a leak.
import { describe, expect, it } from 'vitest';
import { type Node, walk } from '../src/ast/index.ts';
import { parse } from '../src/parser/index.ts';

/** Everything the parse reports as a side effect of scanning, i.e. everything a leak could corrupt. */
function scanFacts(src: string, ts: boolean, jsx: boolean) {
    const r = parse(src, { ts, jsx });
    return {
        errors: r.errors.length,
        noSideEffectsAt: r.noSideEffectsAt,
        topLevelThis: r.topLevelThis?.length ?? 0,
        hasRequire: r.hasRequire,
        hasJSX: r.hasJSX,
        hasImportSyntax: r.hasImportSyntax,
        hasTopLevelAwait: r.hasTopLevelAwait,
        hasEsmImport: r.hasEsmImport,
        hasEsmExport: r.hasEsmExport,
        hasTopLevelReturn: r.hasTopLevelReturn,
        // NOT nodeCount: a sequence expression and an array literal legitimately differ. Node-id
        // leakage gets its own check below, where the confound does not apply.
    };
}

// `(a, X)` reaches TRI_MAYBE on `(a,` and then fails in `parseParams`, so X is parsed, rewound, and
// parsed again. `[a, X]` is never a candidate parameter list.
const SPECULATES = (x: string) => `(a, ${x})`;
const CONTROL = (x: string) => `[a, ${x}]`;

const CONSTRUCTS: [string, string][] = [
    ['no-side-effects annotation', '/*@__NO_SIDE_EFFECTS__*/ function f(){}'],
    ['pure annotation', '/*@__PURE__*/ f()'],
    ['top-level this', 'this'],
    ['require call', 'require("x")'],
    ['import.meta', 'import.meta'],
    ['dynamic import', 'import("x")'],
    ['nested function', 'function g(){ return 1 }'],
    ['class expression', 'class C { m(){} }'],
    ['template', '`t${1}`'],
    ['regex', '/[)]/'],
];

describe('a failed speculation leaves no trace', () => {
    for (const [label, construct] of CONSTRUCTS) {
        it.each([false, true])(`${label} (ts=%s)`, (ts) => {
            expect(scanFacts(SPECULATES(construct), ts, false)).toEqual(scanFacts(CONTROL(construct), ts, false));
        });
    }

    it('JSX element', () => {
        expect(scanFacts(SPECULATES('<div/>'), false, true)).toEqual(scanFacts(CONTROL('<div/>'), false, true));
    });
});

describe('node ids allocated by a rewound speculation', () => {
    // `nodeCount` is `program.id - baseId + 1`: ids ALLOCATED, not nodes retained. A speculation that
    // builds an AST and then rewinds leaves a gap, so the count overstates the tree. oxc has the same
    // property — its arena does not free on rewind — so this is documented, not a defect.
    //
    // Pinned rather than asserted away, so a change that explodes the gap is visible. Measured on real
    // corpora the port moved this the RIGHT way overall: crashcat TS 206,019 -> 205,831 nodes (-188),
    // because the old code parsed a ts-annotated arrow's parameters, rewound, and parsed them again.
    const gap = (src: string, ts: boolean): number => {
        const r = parse(src, { ts, jsx: false });
        let walked = 0;
        walk(r.program as Node, () => {
            walked++;
        });
        return r.nodeCount - walked;
    };

    it.each([
        ['[a, b]', 0],
        ['(a, b) => a + b', 0],
        ['(a, b)', 4],
        ['(a, function g(){ return 1 })', 4],
    ])('%s leaves a gap of %i', (src, expected) => {
        expect(gap(src, true)).toBe(expected);
    });

    it('never UNDER-counts — a gap below zero would mean lost nodes', () => {
        for (const src of ['[a, b]', '(a, b)', '(a, b) => a + b', 'x ? y => ({ y }) : z => ({ z })'])
            for (const ts of [false, true]) expect(gap(src, ts), src).toBeGreaterThanOrEqual(0);
    });
});
