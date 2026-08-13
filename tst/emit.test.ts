import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as meriyah from 'meriyah';
import { parse } from '../src/parser.ts';
import { createAst } from '../src/ast.ts';
import { emitModule } from '../src/emit.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');
const CRASHCAT_SRC = resolve(REPO, '..', 'crashcat', 'src');

/** parse `src` (ts on) and strip to JS. */
function strip(src: string): string {
    const { ast, program } = parse(createAst(), src, { ts: true });
    return emitModule(ast, program, { stripTypes: true });
}

/** collect every .ts file under a dir. */
function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) out.push(...walkTs(p));
        else if (entry.endsWith('.ts')) out.push(p);
    }
    return out;
}

describe('emit — identity (no TS)', () => {
    const source = readFileSync(THREE, 'utf8');
    const { ast, program } = parse(createAst(), source, { ts: false });

    it('parses three.core.js with no errors', () => {
        expect(ast.errors).toEqual([]);
    });

    it('stripTypes:false is byte-for-byte identical', () => {
        expect(emitModule(ast, program, { stripTypes: false })).toBe(source);
    });

    it('stripTypes:true on TS-free source is byte-for-byte identical', () => {
        expect(emitModule(ast, program, { stripTypes: true })).toBe(source);
    });
});

describe('emit — strip oracle (every crashcat file)', () => {
    const files = walkTs(CRASHCAT_SRC);

    it('finds the crashcat corpus', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    for (const file of files) {
        const rel = file.slice(CRASHCAT_SRC.length + 1);
        it(`strips ${rel} to valid JS`, () => {
            const source = readFileSync(file, 'utf8');
            const stripped = strip(source);

            // 1) our parser (ts:false) accepts it with zero errors.
            const { ast } = parse(createAst(), stripped, { ts: false });
            expect(ast.errors).toEqual([]);

            // 2) meriyah (a pure-JS ESTree parser) accepts it -> all TS is gone.
            expect(() => meriyah.parse(stripped, { module: true, next: true })).not.toThrow();
        });
    }
});

describe('emit — position preservation', () => {
    it('keeps a known identifier at the same offset after strip', () => {
        const src = 'const marker: number = 1; function keep(a: string): void {}';
        const off = src.indexOf('keep');
        const out = strip(src);
        expect(out.indexOf('keep')).toBe(off);
        // line count preserved
        const nl = (s: string) => (s.match(/\n/g) ?? []).length;
        const multi = 'interface I {\n  a: number;\n}\nconst x = 1;';
        expect(nl(strip(multi))).toBe(nl(multi));
    });
});

describe('emit — enum execution', () => {
    it('executes numeric auto-increment + string + expression members', async () => {
        const src = 'export enum E { A, B = 5, C, S = "str", X = 1 << 4 }';
        const code = strip(src);
        const mod = await import('data:text/javascript,' + encodeURIComponent(code));
        const E = mod.E;
        // forward mappings
        expect(E.A).toBe(0);
        expect(E.B).toBe(5);
        expect(E.C).toBe(6);
        expect(E.S).toBe('str');
        expect(E.X).toBe(16);
        // reverse mappings for numeric members
        expect(E[0]).toBe('A');
        expect(E[5]).toBe('B');
        expect(E[6]).toBe('C');
        expect(E[16]).toBe('X');
        // no reverse mapping for the string member
        expect(E['str']).toBeUndefined();
    });

    it('lowers a non-exported enum with runtime + reverse maps', async () => {
        const src = 'enum Color { Red, Green, Blue }\nexport const first = Color.Red;\nexport const name = Color[1];';
        const code = strip(src);
        const mod = await import('data:text/javascript,' + encodeURIComponent(code));
        expect(mod.first).toBe(0);
        expect(mod.name).toBe('Green');
    });
});

describe('emit — per-rule snippets', () => {
    const cases: [string, string, string][] = [
        ['type annotation', 'const x: number = 1;', 'const x         = 1;'],
        ['function types', 'function f<T>(a: T): T { return a; }', 'function f   (a   )    { return a; }'],
        ['as expression', 'let y = a as string;', 'let y = a          ;'],
        ['satisfies', 'let y = a satisfies Foo;', 'let y = a              ;'],
        ['non-null', 'const z = w!;', 'const z = w ;'],
        ['definite var', 'let d!: number;', 'let d         ;'],
        ['optional param', 'function g(a?: string) {}', 'function g(a         ) {}'],
        ['interface (whole)', 'interface I { a: number; }', '                          '],
        ['type alias (whole)', 'type T = number;', '                '],
        ['declare (whole)', 'declare const c: number;', '                        '],
        ['import type (whole)', 'import type { A } from "m";', '                           '],
        ['type-only specifier first', 'import { type A, b } from "m";', 'import {         b } from "m";'],
        ['type-only specifier last', 'import { b, type C } from "m";', 'import { b         } from "m";'],
        ['export type specifier', 'export { type A, b };', 'export {         b };'],
        ['call type args', 'foo<X>(y);', 'foo   (y);'],
        ['new type args', 'new Bar<Z>(q);', 'new Bar   (q);'],
        ['implements clause', 'class C implements A, B {}', 'class C                 {}'],
        ['definite prop', 'class C { p!: number; }', 'class C { p         ; }'],
        ['optional prop', 'class C { p?: number; }', 'class C { p         ; }'],
        ['readonly member modifier', 'class C { readonly p = 1; }', 'class C {          p = 1; }'],
        ['static kept, readonly blanked', 'class C { static readonly p = 1; }', 'class C { static          p = 1; }'],
    ];

    for (const [name, input, expected] of cases) {
        it(name, () => {
            expect(strip(input)).toBe(expected);
        });
    }

    it('abstract class + abstract member', () => {
        const src = 'abstract class D { abstract m(): void; }';
        const out = strip(src);
        expect(out).toBe('         class D {                     }');
        expect(out.length).toBe(src.length);
    });

    it('overload signature is removed, implementation kept', () => {
        const src = 'function f(a: number): void;\nfunction f(a) {}';
        const out = strip(src);
        expect(out).toBe('                            \nfunction f(a) {}');
    });

    it('bodyless enum-free strip parses as JS', () => {
        const src = 'export type A = number;\nexport const x: A = 1;';
        const out = strip(src);
        expect(() => meriyah.parse(out, { module: true, next: true })).not.toThrow();
    });
});

describe('emit — invariants', () => {
    it('stripTypes:false returns source verbatim for TS input', () => {
        const src = 'const x: number = 1;';
        const { ast, program } = parse(createAst(), src, { ts: true });
        expect(emitModule(ast, program, { stripTypes: false })).toBe(src);
    });

    it('blanking never changes non-newline whitespace layout offsets', () => {
        const src = 'function f(a: number, b: string): void {\n  return;\n}';
        const out = strip(src);
        expect(out.length).toBe(src.length);
        // every newline preserved at its offset
        for (let i = 0; i < src.length; i++) {
            if (src[i] === '\n') expect(out[i]).toBe('\n');
        }
    });

    // guards against emit accidentally touching value identifiers
    it('leaves value code intact', () => {
        const src = 'const add = (a: number, b: number): number => a + b;';
        const out = strip(src);
        // reconstruct: value tokens survive
        expect(out).toContain('const add =');
        expect(out).toContain('=> a + b;');
    });
});
