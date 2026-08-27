import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

const evalModule = async (code: string): Promise<Record<string, unknown>> =>
    (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as Record<string, unknown>;

/** A multi-module TS+ESM app (single chunk) exercising imports, cross-module renames,
 *  a class with a private field, an enum, a default export, and computed values — the
 *  constructs the printer link mode must get right. */
const FILES: Record<string, string> = {
    '/main.ts': `
        import { add, Counter } from './lib.ts';
        import shout from './util.ts';
        import { Dir } from './enums.ts';
        export const sum = add(2, 3);
        const counter = new Counter(10);
        counter.inc();
        counter.inc();
        export const count = counter.value;
        export const loud = shout('hi');
        export const dir = Dir.Up + '/' + Dir.Down;
    `,
    '/lib.ts': `
        export function add(a: number, b: number): number { return a + b; }
        export class Counter {
            #n: number;
            constructor(start: number) { this.#n = start; }
            inc(): void { this.#n++; }
            get value(): number { return this.#n; }
        }
    `,
    '/util.ts': `export default function shout(s: string): string { return s.toUpperCase() + '!'; }`,
    '/enums.ts': `export enum Dir { Up = 1, Down }`,
};

async function entryCode(minify: boolean): Promise<string> {
    const r = await bundle({ input: '/main.ts', fs: createMemoryFs(FILES), external: [], output: { minify } });
    expect(r.errors).toEqual([]);
    expect(r.chunks.length).toBe(1);
    return r.chunks[0].code;
}

describe('bundle — minify', () => {
    it('executes identically to non-minify (single chunk)', async () => {
        const plain = await entryCode(false);
        const min = await entryCode(true);

        expect(min.length).toBeLessThan(plain.length);
        expect(min).not.toContain('\n    ');

        const a = await evalModule(plain);
        const b = await evalModule(min);
        for (const key of ['sum', 'count', 'loud', 'dir']) {
            expect(b[key], key).toBe(a[key]);
        }
    });

    it('exported values are concretely correct under minify', async () => {
        const ns = await evalModule(await entryCode(true));
        expect(ns.sum).toBe(5);
        expect(ns.count).toBe(12);
        expect(ns.loud).toBe('HI!');
        expect(ns.dir).toBe('1/2');
    });

    it('mangles top-level names to short base54 identifiers, preserving public exports', async () => {
        const min = await entryCode(true);
        // Cross-module top-level names are gone from the body…
        expect(min).not.toMatch(/function add\b/);
        expect(min).not.toMatch(/class Counter\b/);
        expect(min).not.toMatch(/function shout\b/);
        // …replaced by short mangled ones, with public names kept only in the export alias.
        expect(min).toMatch(/function [a-zA-Z$]\(/); // a 1-char function name
        expect(min).toContain(' as sum');
        expect(min).toContain(' as loud');
    });

    it('mangles nested locals with sibling reuse, preserving closure references', async () => {
        // Each closure references an OUTER binding (`base`, `factor`) while declaring its own
        // locals — a nested local must never shadow an outer name it still reads.
        const files = {
            '/main.ts': `
                import { factor } from './cfg.ts';
                export function makeAdders(base) {
                    const scaledBase = base * factor;
                    return [1, 2, 3].map((delta) => {
                        const local = scaledBase + delta * factor;
                        return () => local + base;
                    });
                }
                export const results = makeAdders(10).map((fn) => fn());
            `,
            '/cfg.ts': `export const factor = 100;`,
        };
        const run = async (minify: boolean) => {
            const r = await bundle({ input: '/main.ts', fs: createMemoryFs(files), external: [], output: { minify } });
            expect(r.errors).toEqual([]);
            const ns = await evalModule(r.chunks[0].code);
            return { code: r.chunks[0].code, results: ns.results as number[] };
        };
        const plain = await run(false);
        const min = await run(true);
        // base = 10, factor = 100 → scaledBase = 1000; local = 1000 + delta*100; result = local + 10
        expect(plain.results).toEqual([1110, 1210, 1310]);
        expect(min.results).toEqual(plain.results); // mangling preserved every closure reference
        // Nested param `delta` and local `scaledBase` are gone from the mangled body.
        expect(min.code).not.toContain('scaledBase');
        expect(min.code).not.toContain('delta');
    });

    it('rewrites dynamic import() to the target chunk path', async () => {
        const files = {
            '/main.ts': `export async function lazy() { const m = await import('./lazy.ts'); return m.value * 2; }`,
            '/lazy.ts': `export const value = 21;`,
        };
        const r = await bundle({ input: '/main.ts', fs: createMemoryFs(files), external: [], output: { minify: true } });
        expect(r.errors).toEqual([]);
        expect(r.chunks.length).toBe(2);
        const entry = r.chunks.find((c) => c.isEntry)!;
        const lazyChunk = r.chunks.find((c) => !c.isEntry)!;
        expect(entry.code).toContain(`import('./${lazyChunk.fileName}')`);
        expect(entry.code).toMatch(/async function \w+\(\)\{/); // local mangled
        expect(entry.code).toContain(' as lazy'); // public export name preserved
    });
});

describe('emit-layer glue respects minify.whitespace', () => {
    // The AST printer is whitespace-aware, but the bundle's hand-built glue (import/export clauses,
    // the namespace object) carried readable padding regardless — 1,366 bytes on crashcat, 331 on
    // three.js, measured against oxc-minify on identical input.
    const files = {
        '/main.ts': [
            "import { one, two } from 'ext';",
            "import def from 'ext2';",
            "import * as ns from './lib.ts';",
            'export const out = one() + two() + def() + ns.a;',
        ].join('\n'),
        '/lib.ts': 'export const a = 1;\nexport const b = 2;',
    };
    const build = async (minify: boolean | Record<string, unknown>) => {
        const r = await bundle({ entry: '/main.ts', fs: createMemoryFs(files), external: ['ext', 'ext2'], output: { minify } });
        expect(r.errors).toEqual([]);
        return r.code;
    };

    it('emits import and export clauses with no readability padding', async () => {
        const code = await build(true);
        expect(code).toMatch(/import\{one as \w+,two as \w+\}from'ext';/);
        expect(code).not.toMatch(/import \{ /);
        expect(code).not.toMatch(/, \w+ as /);
    });

    it('keeps the space a DEFAULT import actually needs', async () => {
        // `import{a}from'x'` is fine, but a bare default local cannot be glued to the keyword —
        // `importd from'x'` is a different token stream.
        const code = await build(true);
        expect(code).toMatch(/import \w+ from'ext2';/);
        expect(code).not.toMatch(/import\w+ from/);
    });

    it('emits a compact namespace object', async () => {
        const code = await build(true);
        // What this pins is the absence of PADDING, not the surrounding syntax. The namespace object
        // is emitter-generated text, so a chunk-level compress pass reshapes it freely — `const` ->
        // `let`, and joined into a neighbouring declaration (`let i=1,e={a:1}`), both smaller.
        expect(code).toMatch(/\w+=\{\w+:/); // no padding inside the literal
        expect(code).not.toMatch(/\w+ = \{ /);
        expect(code).toMatch(/Object\.defineProperty\(\w+,Symbol\.toStringTag,\{value:'Module'\}\);/);
    });

    it('leaves the readable form alone when whitespace minification is off', async () => {
        const code = await build({ whitespace: false, mangle: false, compress: false });
        expect(code).toContain("import { one, two } from 'ext';");
    });

    it('still parses and evaluates', async () => {
        const files2 = { '/main.ts': "import * as ns from './lib.ts';\nexport const out = ns.a + ns.b;", '/lib.ts': 'export const a = 1;\nexport const b = 2;' };
        const r = await bundle({ entry: '/main.ts', fs: createMemoryFs(files2), output: { minify: true } });
        expect(r.errors).toEqual([]);
        expect((await evalModule(r.code)).out).toBe(3);
    });

    it('produces a source map whose line count matches the minified code', async () => {
        // The sourcemap suites never exercised `minify`, so this pairing was untested. Compacting the
        // glue moves COLUMNS only — if it ever added or dropped a line, the map would describe a
        // different number of generated lines than the code has and every segment below would shift.
        const r = (await bundle({
            entry: '/main.ts',
            fs: createMemoryFs(files),
            external: ['ext', 'ext2'],
            output: { minify: true, sourcemap: true },
        })) as unknown as { code: string; map?: { mappings: string } };
        const mappings = r.map?.mappings;
        expect(mappings).toBeTruthy();
        // What this guards is a GROSS desync — a map describing a different chunk than the code, the
        // failure mode `joinParts` warns about where every line sat ~30 lines off. It is deliberately
        // not exact: `joinParts` appends one empty mapping line for the trailing newline, and whether
        // a `//# sourceMappingURL=` line is appended shifts the count again, so pinning equality makes
        // the test fail on newline conventions rather than on broken maps.
        const codeLines = r.code.replace(/\n$/, '').split('\n').length;
        const groups = mappings!.split(';').length;
        expect(groups).toBeGreaterThanOrEqual(codeLines);
        expect(groups).toBeLessThanOrEqual(codeLines + 1);
    });
});
