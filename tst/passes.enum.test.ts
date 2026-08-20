import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import { tsLower } from '../src/passes/lower-ts.ts';
import { transform } from '../src/passes/traverse.ts';
import { parse } from '../src/parser/index.ts';
import { printModule } from '../src/print/print-js.ts';
import { createPrinter, finishPrinter } from '../src/print/printer.ts';

/** Lower via the transform stage (parse → analyze → transform) and print. */
function lower(src: string): string {
    const { program } = parse(src, { ts: true, jsx: false });
    const sem = createSemantic();
    analyze(sem, program);
    transform(program, sem, [tsLower]);
    const p = createPrinter({ minify: false });
    printModule(p, program);
    return finishPrinter(p);
}

/** Execute the lowered module (strip `export ` first) and return the named enum object. */
function evalEnum(src: string, name: string): Record<string, unknown> {
    const code = lower(src).replace(/^export /gm, '');
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of generated code
    return new Function(`${code}\nreturn ${name};`)() as Record<string, unknown>;
}

describe('transform stage — enum lowering', () => {
    it('lowers a value enum to a var + IIFE (no TSEnumDeclaration survives)', () => {
        const out = lower('enum E { A, B }');
        expect(out).not.toMatch(/enum/);
        expect(out).toMatch(/var E;/);
        expect(out).toMatch(/\(E \|\| \(E = \{\}\)\)/);
    });

    it('auto-numbers members and reverse-maps them', () => {
        const E = evalEnum('enum E { A, B, C }', 'E');
        expect(E.A).toBe(0);
        expect(E.B).toBe(1);
        expect(E.C).toBe(2);
        expect(E[0]).toBe('A');
        expect(E[2]).toBe('C');
    });

    it('continues numbering from an explicit initializer', () => {
        const E = evalEnum('enum E { A = 5, B, C }', 'E');
        expect(E.A).toBe(5);
        expect(E.B).toBe(6);
        expect(E.C).toBe(7);
    });

    it('qualifies prior-member references (BOTH = A | B → E.A | E.B = 3)', () => {
        const E = evalEnum('enum E { A = 1, B = 2, BOTH = A | B }', 'E');
        expect(E.A).toBe(1);
        expect(E.B).toBe(2);
        expect(E.BOTH).toBe(3);
    });

    it('handles string enums (no reverse map)', () => {
        const E = evalEnum('enum E { X = "x", Y = "y" }', 'E');
        expect(E.X).toBe('x');
        expect(E.Y).toBe('y');
        expect(E.x).toBeUndefined();
    });

    it('lowers `export enum` to `export var` + IIFE', () => {
        const out = lower('export enum Dir { Up = 1, Down }');
        expect(out).toMatch(/export var Dir;/);
        const Dir = evalEnum('export enum Dir { Up = 1, Down }', 'Dir');
        expect(Dir.Up).toBe(1);
        expect(Dir.Down).toBe(2);
    });

    it('lowers an enum nested in a function body', () => {
        const out = lower('function f() { enum Inner { A, B } return Inner.B; }');
        expect(out).not.toMatch(/enum/);
        expect(out).toMatch(/var Inner;/);
    });

    it('leaves `declare enum` alone (erased elsewhere, not lowered)', () => {
        const { program } = parse('declare enum E { A }', { ts: true, jsx: false });
        const sem = createSemantic();
        analyze(sem, program);
        transform(program, sem, [tsLower]);
        // still a TSEnumDeclaration (declare) — the pass must not touch it
        expect(program.data.body[0]?.type).toBeDefined();
        const t = program.data.body[0] as { type: number; data: { declare?: boolean } };
        expect(t.data.declare).toBe(true);
    });
});
