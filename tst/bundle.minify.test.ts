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
