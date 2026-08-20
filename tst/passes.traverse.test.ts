import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { type Node, TYPE_COUNT, walk } from '../src/ast.ts';
import { traverse, type Visitor } from '../src/passes/traverse.ts';
import { parse } from '../src/parser/index.ts';

/** Reference pre-order node sequence via the plain generic `walk`. */
function walkSeq(program: Node): number[] {
    const out: number[] = [];
    walk(program, (n) => {
        out.push(n.id);
    });
    return out;
}

/** Same sequence via the codegen'd-walker transform, using a no-mutation record-all visitor. */
function transformSeq(src: string): { ref: number[]; got: number[] } {
    const { program } = parse(src, { ts: true, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    const ref = walkSeq(program);
    const got: number[] = [];
    const record = (n: Node): void => {
        got.push(n.id);
    };
    const enter = new Array(TYPE_COUNT).fill(record) as ((n: Node) => void)[];
    const recorder: Visitor = { name: 'record', enter: enter as never, exit: null };
    traverse(program, sem, [recorder]);
    return { ref, got };
}

describe('transform stage — codegen walker correctness oracle', () => {
    // A structurally-varied program exercising many node kinds + list/single/nullable child slots.
    const RICH = `
        import { a, b as c } from './m';
        export const x = [1, 2, , ...rest], { p, q = 3 } = obj;
        function f<T>(g: (n: number) => T = () => x, ...args: T[]): T | null {
            for (const y of args) { if (y) return y; else continue; }
            try { g\`t\${x}\`; } catch (e) { throw e; } finally { label: while (x) break label; }
            return a?.b.c!.d ?? c;
        }
        class K extends Base { #p = 1; static s() { return this.#p; } get v() { return 2; } }
        const arrow = async (m) => { switch (m) { case 1: return; default: {} } };
        type U = { [k: string]: number } | [string, ...number[]];
        enum E { A, B = A | 2 }
    `;

    it('codegen walkers visit the same nodes, in the same pre-order, as `walk`', () => {
        const { ref, got } = transformSeq(RICH);
        expect(got).toEqual(ref);
        expect(got.length).toBeGreaterThan(100);
    });

    it('holds for a JS regex/template/optional-chain mix too', () => {
        const { ref, got } = transformSeq('const r = /a[b]/g.test(`x${y?.z}`) ? a ** b : -c; export default r;');
        expect(got).toEqual(ref);
    });
});
