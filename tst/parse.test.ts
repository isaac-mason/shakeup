import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, test } from 'vitest';
import { parse } from '../src/parser.ts';
import { walk, N, TYPE_NAME, type Node } from '../src/ast.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const THREE = resolve(REPO, 'llm/spikes/node_modules/three/build/three.core.js');
const CRASHCAT_SRC = '/Users/isaacmason/Development/crashcat/src';

// Each parse is standalone (no shared arena in the typedata model); parse
// returns { program, errors, lines, nodeCount }.
function parseFresh(source: string, ts: boolean) {
    return parse(source, { ts });
}

describe('three.core.js', () => {
    it('parses with { ts: false }, no errors, > 100k nodes', () => {
        const src = readFileSync(THREE, 'utf8');
        const { errors, nodeCount } = parseFresh(src, false);
        expect(errors).toEqual([]);
        expect(nodeCount).toBeGreaterThan(100_000);
    });
});

describe('crashcat/src *.ts', () => {
    const files = execSync(`find "${CRASHCAT_SRC}" -name '*.ts'`, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .sort();

    it('found ~99 files', () => {
        expect(files.length).toBeGreaterThan(50);
    });

    test.each(files)('parses %s with { ts: true } and 0 errors', (file) => {
        const src = readFileSync(file, 'utf8');
        const { errors } = parseFresh(src, true);
        expect(errors).toEqual([]);
    });
});

describe('tricky snippet corpus', () => {
    const jsSnippets: Record<string, string> = {
        'regex vs divide': 'const r=/a[/]b/g; const d=x/y/z;',
        'nested templates': 'const s = `a${`b${c}d`}e${f}`;',
        'optional chaining + nullish assign': 'a?.b?.c?.(); x ??= y; obj.a ??= 1; a?.[b]?.c;',
        'private fields + #x in obj': 'class C { #x = 1; m(o){ return #x in o ? this.#x : 0; } }',
        'generators + async arrows': 'function* g(){ yield* h(); } const f = async (x) => await x; const af = async function*(){ yield 1 };',
        'labeled loops with break': 'outer: for (let i=0;i<3;i++){ inner: for(;;){ break outer; continue inner; } }',
        'destructuring defaults in params': 'function f({a=1,b:{c=2}={}}=[], [d=3,...e]=[]){ return a+c+d; }',
        'getters/setters class + object': 'class C { get x(){return 1} set x(v){} } const o = { get y(){return 2}, set y(v){}, [z]:1 };',
        'static blocks': 'class C { static #s = 1; static { this.t = C.#s; } }',
        'for-await-of': 'async function f(xs){ for await (const x of xs){ console.log(x); } }',
        'tagged templates': 'tag`a${b}c`; String.raw`\\n${x}`;',
        'new.target': 'function F(){ if (new.target) {} }',
        'import.meta': 'const u = import.meta.url;',
        'dynamic import': 'const m = import("./x.js"); import("./y.js", { with: { type: "json" } });',
    };

    const tsSnippets: Record<string, string> = {
        'interface computed key': 'enum E { A } interface I { [E.A]: string; readonly x?: number; }',
        'mapped type': 'type M<T> = { [K in keyof T]?: T[K] };',
        'conditional + infer': 'type Unwrap<T> = T extends Promise<infer U> ? U : T;',
        'template literal type': 'type Route = `/${string}/${number}`;',
        'tuple named members': 'type P = [x: number, y?: number, z: string[]];',
        'tuple labeled rest': 'type P = [x: number, ...rest: string[]];',
        'as const': 'const c = [1, 2, 3] as const;',
        'satisfies': 'const cfg = { a: 1 } satisfies Record<string, number>;',
        'enum with initializers': 'enum Color { Red = 1, Green = "g", Blue = Red << 1 }',
        'abstract class': 'abstract class A { abstract m(): void; concrete(){ return 1; } }',
        'param properties': 'class C { constructor(private readonly x: number, public y = 2){} }',
        'overload signatures': 'function f(x: number): number;\nfunction f(x: string): string;\nfunction f(x: any){ return x; }',
        'import type / export type': 'import type { A } from "./a"; export type { B }; import { type C, d } from "./c";',
        'generic arrow': 'const id = <T,>(x: T): T => x;',
        'nested generics >> split': 'let m: Map<string, Map<string, number>>; let d: Array<Array<Array<number>>>;',
        'indexed access + keyof': 'type V = Record<string, number>[keyof Record<string, number>];',
        'union/intersection': 'type U = A | B | C; type X = A & B & { c: number };',
        // regressions from the emit-agent bug report
        'extends generic superclass': 'class C extends Base<number> { m() { return 1; } } interface I extends A<T>, B {}',
        'optional method': 'class C { m?(): void; n?(x: number) { return x; } } interface J { o?(): void }',
        'class index signature': 'class C { [k: string]: number; x = 1; }',
        'abstract span includes keyword': 'abstract class A { abstract m(): void; }',
    };

    for (const [name, src] of Object.entries(jsSnippets)) {
        it(`js: ${name}`, () => {
            const { errors } = parseFresh(src, false);
            expect(errors, JSON.stringify(errors)).toEqual([]);
        });
    }

    for (const [name, src] of Object.entries(tsSnippets)) {
        it(`ts: ${name}`, () => {
            const { errors } = parseFresh(src, true);
            expect(errors, JSON.stringify(errors)).toEqual([]);
        });
    }
});

describe('fixed parser regressions', () => {
    // Originally a suspected-bug guard: labeled rest tuple members were rejected.
    // Both rest forms must parse now.
    it('regression: labeled and unlabeled rest tuple members parse', () => {
        const unlabeled = parseFresh('type P = [x: number, ...string[]];', true);
        expect(unlabeled.errors).toEqual([]);

        const labeled = parseFresh('type P = [x: number, ...rest: string[]];', true);
        expect(labeled.errors).toEqual([]);
    });
});

describe('ChainExpression placement (phase 3b — was chain-gap-probe.ts)', () => {
    // A ChainExpression wraps the OUTERMOST link of an optional chain; parentheses
    // TERMINATE the chain. `a?.b.c` short-circuits the whole chain if `a` is
    // nullish; `(a?.b).c` throws (member access on undefined outside the chain).
    // Before phase 3b these parsed byte-identically — a latent miscompile. Now
    // their wrapper PLACEMENT must differ.
    const shape = (src: string): string => {
        const { program, errors } = parseFresh(src, false);
        expect(errors, JSON.stringify(errors)).toEqual([]);
        const parts: string[] = [];
        walk(program, (n: Node) => { parts.push(TYPE_NAME[n.type]); });
        return parts.join(' ');
    };
    const countChains = (src: string): number => {
        const { program } = parseFresh(src, false);
        let n = 0;
        walk(program, (node) => { if (node.type === N.ChainExpression) n++; });
        return n;
    };

    it('`a?.b.c` vs `(a?.b).c` produce DIFFERENT structures (wrapper placement differs)', () => {
        const chained = shape('x = a?.b.c;');
        const parened = shape('x = (a?.b).c;');
        expect(chained).not.toEqual(parened);
        // chained: ChainExpression wraps the outermost (.c) member
        expect(chained).toContain('ChainExpression StaticMemberExpression');
        // parened: ChainExpression sits INSIDE, wrapping only the inner (a?.b)
        expect(parened).toContain('StaticMemberExpression ChainExpression');
    });

    it('`a?.b()` vs `(a?.b)()` place the ChainExpression differently', () => {
        const chained = shape('a?.b();');
        const parened = shape('(a?.b)();');
        expect(chained).not.toEqual(parened);
        // chained: wrapper is outermost, over the CallExpression
        expect(chained).toContain('ChainExpression CallExpression');
        // parened: wrapper is the callee, inside the CallExpression
        expect(parened).toContain('CallExpression ChainExpression');
    });

    it('exactly one ChainExpression per chain, regardless of link count', () => {
        expect(countChains('a?.b?.c?.d;')).toBe(1);
        expect(countChains('a.b?.c.d.e;')).toBe(1); // one optional anywhere wraps the whole run
        expect(countChains('a?.[b];')).toBe(1);
        expect(countChains('a.b.c;')).toBe(0); // no optional link -> no wrapper
    });

    it('parentheses terminate a chain: `(a?.b.c).d?.e` yields TWO ChainExpressions', () => {
        // inner run `a?.b.c` wraps once (terminated by `)`), outer run `.d?.e` wraps again
        expect(countChains('(a?.b.c).d?.e;')).toBe(2);
    });

    it('a nested/deep chain still wraps exactly its outermost link', () => {
        // `a.b().c?.d` — the call `a.b()` is non-optional but inside the chain
        // because `?.d` follows; exactly one wrapper over the whole thing.
        expect(countChains('a.b().c?.d;')).toBe(1);
        const s = shape('a.b().c?.d;');
        // wrapper is the very outermost node in the expression statement
        expect(s).toContain('ExpressionStatement ChainExpression');
    });
});

describe('termination on malformed input (must return synchronously, no hang)', () => {
    const bad: Record<string, { src: string; ts: boolean }> = {
        'unbalanced braces': { src: '{{{{', ts: false },
        'const = ;': { src: 'const = ;', ts: false },
        'interface X { | }': { src: 'interface X { | }', ts: true },
        'unterminated template': { src: 'const s = `abc${x', ts: false },
        'unterminated string': { src: 'const s = "abc', ts: false },
        'dangling operators': { src: 'a + + + + ;', ts: false },
    };

    for (const [name, { src, ts }] of Object.entries(bad)) {
        it(`terminates: ${name}`, () => {
            // Just reaching the assertion proves the parse returned (no hang);
            // errors > 0 is allowed but not required.
            const { program } = parseFresh(src, ts);
            expect(program.id).toBeGreaterThan(0);
            // walk must also terminate over whatever partial tree was produced
            let n = 0;
            walk(program, () => {
                n++;
            });
            expect(n).toBeGreaterThan(0);
        });
    }
});
