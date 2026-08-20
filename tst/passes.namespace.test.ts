import { describe, expect, it } from 'vitest';
import { analyze, createSemantic } from '../src/analysis/semantic.ts';
import type { Node } from '../src/ast.ts';
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

/** Execute the lowered module (strip `export `) and return the named namespace object. */
function evalNs(src: string, name: string): Record<string, unknown> {
    const code = lower(src).replace(/^export /gm, '');
    // biome-ignore lint/security/noGlobalEval: test-only evaluation of generated code
    return new Function(`${code}\nreturn ${name};`)() as Record<string, unknown>;
}

describe('transform stage — namespace lowering', () => {
    it('lowers a value namespace to var + IIFE (no TSModuleDeclaration survives)', () => {
        const out = lower('namespace N { export const y = 1; }');
        expect(out).not.toMatch(/namespace/);
        expect(out).toMatch(/var N =/);
        expect(out).toMatch(/\(N \|\| \{\}\)/);
    });

    it('exposes exported const/function/class members; hides non-exported', () => {
        const N = evalNs(
            [
                'namespace N {',
                '  export const a = 1;',
                '  const secret = 2;',
                '  export function f() { return a + secret; }',
                '  export class C {}',
                '}',
            ].join('\n'),
            'N',
        );
        expect(N.a).toBe(1);
        expect(typeof N.f).toBe('function');
        expect((N.f as () => number)()).toBe(3);
        expect(typeof N.C).toBe('function');
        expect(N.secret).toBeUndefined();
    });

    it('erases type-only members (interface / type alias)', () => {
        const out = lower('namespace N { export interface I { a: number } export type T = string; export const v = 1; }');
        expect(out).not.toMatch(/interface|type T/);
        const N = evalNs('namespace N { export interface I { a: number } export const v = 1; }', 'N');
        expect(N.v).toBe(1);
    });

    it('lowers `export namespace` to `export var`', () => {
        const out = lower('export namespace P { export const x = 5; }');
        expect(out).toMatch(/export var P =/);
        const P = evalNs('export namespace P { export const x = 5; }', 'P');
        expect(P.x).toBe(5);
    });

    it('lowers nested namespaces with parent-linking (N.M.x)', () => {
        const out = lower('namespace N { export namespace M { export const x = 1; } }');
        expect(out).not.toMatch(/namespace/);
        const N = evalNs('namespace N { export namespace M { export const x = 1; } }', 'N') as {
            M: { x: number };
        };
        expect(N.M.x).toBe(1);
    });

    it('leaves `declare namespace` alone', () => {
        const { program } = parse('declare namespace D { const x: number }', { ts: true, jsx: false });
        const sem = createSemantic();
        analyze(sem, program);
        traverse(program, sem, [tsLower]);
        const t = program.data.body[0] as { data: { declare?: boolean } };
        expect(t.data.declare).toBe(true);
    });
});
