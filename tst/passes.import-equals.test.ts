import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { parse } from '../src/parser/index.ts';
import { tsLower } from '../src/passes/lower-ts.ts';
import { traverse } from '../src/passes/traverse.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

function lower(src: string): string {
    const { program } = parse(src, { ts: true, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    traverse(program, sem, [tsLower]);
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return finishPrinter(p);
}

/** Execute the lowered module (strip `export `) and return the named value. */
function evalVal(src: string, expr: string): unknown {
    const code = lower(src).replace(/^export /gm, '');
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of generated code
    return new Function(`${code}\nreturn (${expr});`)();
}

describe('transform stage — import-equals lowering', () => {
    it('lowers `import X = A.B` to `var X = A.B`', () => {
        const out = lower('const A = { B: 1 };\nimport X = A.B;\nexport const r = X;');
        expect(out).not.toMatch(/import/);
        expect(out).toMatch(/var X = A\.B/);
        expect(evalVal('const A = { B: 42 };\nimport X = A.B;\nexport const r = X;', 'r')).toBe(42);
    });

    it('lowers a single-segment alias `import Y = Z`', () => {
        expect(evalVal('const Z = 9;\nimport Y = Z;\nexport const r = Y;', 'r')).toBe(9);
    });

    it('lowers a deep member alias `import X = A.B.C`', () => {
        expect(evalVal('const A = { B: { C: 7 } };\nimport X = A.B.C;\nexport const r = X;', 'r')).toBe(7);
    });

    it('erases a type-only `import type T = A.B`', () => {
        const out = lower('import type T = A.B;\nexport const r = 1;');
        expect(out).not.toMatch(/import|A\.B|var T/);
        expect(out).toMatch(/r = 1/);
    });

    it('mirrors `export import X = o.Y` onto the namespace object', () => {
        expect(evalVal('const o = { Y: 7 };\nnamespace N { export import X = o.Y; }', 'N.X')).toBe(7);
    });

    it('keeps a bare (non-exported) `import X = o.Y` local to the namespace', () => {
        const N = evalVal('const o = { Y: 5 };\nnamespace N { import X = o.Y; export const z = X; }', 'N') as {
            z: number;
            X?: unknown;
        };
        expect(N.z).toBe(5);
        expect(N.X).toBeUndefined(); // not exported → not mirrored
    });

    it('lowers `export import X = A.B` at the top level to an exported var', () => {
        const out = lower('const A = { B: 3 };\nexport import X = A.B;');
        expect(out).toMatch(/export var X = A\.B/);
    });
});
