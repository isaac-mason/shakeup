import { describe, expect, it } from 'vitest';
import { parse } from '../src/index.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter, printerPart } from '../src/print/printer.ts';
import { buildLineTable, decodeMappings, encodeMappings } from '../src/sourcemap.ts';

/** Print `src` with sourcemap building on; return generated code + decoded segments. */
function printWithMap(src: string, minify: boolean) {
    const { program } = parse(src, { ts: false, jsx: false });
    const p = createPrinter({ minify }, { srcLines: Uint32Array.from(buildLineTable(src)), sourceIdx: 0 });
    printModule(p, program);
    const part = printerPart(p);
    // round-trip through encode/decode to prove the segments serialize cleanly
    const decoded = decodeMappings(encodeMappings(part.map!));
    return { code: finishPrinter(p), map: decoded };
}

/** Find (line,col) of the first occurrence of `token` in `code` (0-based). */
function locate(code: string, token: string): { line: number; col: number } {
    const lines = code.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const col = lines[i].indexOf(token);
        if (col >= 0) return { line: i, col };
    }
    throw new Error(`token ${token} not found`);
}

/** Nearest mapped segment at/-before (line,col). */
function traceAt(map: { lines: number[][][] }, line: number, col: number): number[] | null {
    const segs = map.lines[line];
    if (!segs) return null;
    let best: number[] | null = null;
    for (const s of segs) if (s.length >= 4 && s[0] <= col) best = s;
    return best;
}

describe('printer — sourcemap segments', () => {
    it('maps an identifier on a later source line back to that line', () => {
        // `answer` is on source line 2 (0-based); it must map there in the generated output.
        const src = 'const a = 1;\nfunction f() {}\nconst answer = 42;\n';
        const { code, map } = printWithMap(src, false);
        const gen = locate(code, 'answer');
        const seg = traceAt(map, gen.line, gen.col);
        expect(seg).not.toBeNull();
        // seg = [genCol, sourceIdx, srcLine, srcCol]
        expect(seg![1]).toBe(0); // sourceIdx
        expect(seg![2]).toBe(2); // source line 2 (0-based)
    });

    it('every segment points within source bounds and has a real origin', () => {
        const src = 'export const x = { a: 1, b: [2, 3] };\nlet y = x.a + f(1, 2);\n';
        const srcLineCount = src.split('\n').length;
        const { map } = printWithMap(src, false);
        let count = 0;
        for (const segs of map.lines) {
            for (const s of segs) {
                if (s.length >= 4) {
                    count++;
                    expect(s[2]).toBeGreaterThanOrEqual(0);
                    expect(s[2]).toBeLessThan(srcLineCount);
                    expect(s[3]).toBeGreaterThanOrEqual(0);
                }
            }
        }
        expect(count).toBeGreaterThan(0);
    });

    it('minify keeps everything on generated line 0 but preserves source origins', () => {
        const src = 'const a = 1;\nconst b = 2;\nconst zed = 3;\n';
        const { code, map } = printWithMap(src, true);
        expect(code.includes('\n')).toBe(false); // single line under minify
        const gen = locate(code, 'zed');
        const seg = traceAt(map, gen.line, gen.col);
        expect(seg).not.toBeNull();
        expect(seg![2]).toBe(2); // still maps to source line 2
    });
});
