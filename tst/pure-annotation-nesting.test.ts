import { describe, expect, it } from 'vitest';
import { N, type Node, walk } from '../src/ast.ts';
import { bundle, createMemoryFs } from '../src/index.ts';
import { parse } from '../src/parser/index.ts';

// `state.pureAt` is a SINGLE slot holding the position after the most recent `/*@__PURE__*/`, and the
// flag was read when the CallExpression node was CONSTRUCTED — which happens after its arguments are
// parsed. So an annotation inside the arguments overwrote the slot and then consumed it, and the
// OUTER call silently lost its flag:
//
//     /*@__PURE__*/ f('a', /*@__PURE__*/ asset('y'))     ->     f=no, asset=PURE
//
// Reported from a `kit` build, where `blockTexture('kit:stone', { src: asset(...) })` would not
// shake. Both rollup and rolldown drop that expression when unused.
const pureMarks = (src: string): string[] => {
    const p = parse(src, { ts: false, jsx: false, kind: 'module' });
    const out: string[] = [];
    walk(p.program, (n: Node) => {
        if (n.type === N.CallExpression || n.type === N.NewExpression) {
            const callee = (n.data as { callee: Node }).callee;
            out.push(`${callee.name ?? '?'}=${(n.data as { pure?: boolean }).pure === true ? 'PURE' : 'no'}`);
        }
        return true;
    });
    return out;
};

describe('a nested PURE annotation does not steal the outer one', () => {
    it.each([
        ['outer only', "const x = /*@__PURE__*/ f('a', asset('y'));", ['f=PURE', 'asset=no']],
        ['inner only', "const x = f('a', /*@__PURE__*/ asset('y'));", ['f=no', 'asset=PURE']],
        ['both', "const x = /*@__PURE__*/ f('a', /*@__PURE__*/ asset('y'));", ['f=PURE', 'asset=PURE']],
        [
            'both, through an object literal',
            "const x = /*@__PURE__*/ f('a', { src: /*@__PURE__*/ asset('y') });",
            ['f=PURE', 'asset=PURE'],
        ],
        ['both, on `new`', "const x = /*@__PURE__*/ new F(/*@__PURE__*/ asset('y'));", ['F=PURE', 'asset=PURE']],
    ])('%s', (_name, src, expected) => {
        expect(pureMarks(src)).toEqual(expected);
    });

    it('one annotation still marks only the innermost node at that offset', () => {
        // Documented convention: `/*@__PURE__*/ new Matrix3().set(…)` — the `new` and the `.set()`
        // call start at the same offset, and the `new` claims it. Capturing earlier must not change
        // that.
        // Walk order visits the outer `.set()` call first; its callee is a member expression, so the
        // helper labels it with an empty name. What matters is WHICH node carries the flag.
        expect(pureMarks('const x = /*@__PURE__*/ new Matrix3().set(1);')).toEqual(['=no', 'Matrix3=PURE']);
    });

    it("shakes kit's shape: an annotated call whose argument holds another annotated call", async () => {
        // Impure bodies, so ONLY the annotations can license dropping.
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js':
                    'function asset(p) { globalThis.hitA = 1; return p; }\n' +
                    'function blockTexture(n, o) { globalThis.hitB = 1; return n; }\n' +
                    "const unused = /*@__PURE__*/ blockTexture('kit:stone', { src: /*@__PURE__*/ asset('./s.png') });\n" +
                    'export const keep = 1;\n',
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).not.toContain('blockTexture(');
        expect(r.code).not.toContain('asset(');
    });

    it('an UNANNOTATED impure argument still blocks the drop', async () => {
        const r = await bundle({
            entry: '/main.js',
            fs: createMemoryFs({
                '/main.js':
                    'function asset(p) { globalThis.hitA = 1; return p; }\n' +
                    'function blockTexture(n, o) { return n; }\n' +
                    "const unused = /*@__PURE__*/ blockTexture('kit:stone', { src: asset('./s.png') });\n" +
                    'export const keep = 1;\n',
            }),
        });
        expect(r.errors).toEqual([]);
        expect(r.code).toContain('asset(');
    });
});
