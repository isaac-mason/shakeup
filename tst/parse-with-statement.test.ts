// `with` is valid sloppy-script grammar. We used to reject it while PARSING, which was a bundler
// policy applied in the wrong place — the output being an ES module (always strict) is a property of
// the output, not of the grammar.
//
// Now: parsed everywhere it is legal, a grammar error in a module (which IS strict), and refused by
// the BUILD with the reason. esbuild refuses to build one for the same reason; rolldown builds it and
// emits a bundle that dies at load. This is both of the right halves.
//
// Closed 297 harmful test262 misses — the single largest bucket in the suite.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/parser/index.ts';

const errs = (src: string, kind: string) => parse(src, { ts: false, jsx: false, kind } as never).errors;

describe('parsing', () => {
    it.each(['with (o) { x; }', 'with (o) x;', 'function f(){ with (o) { x } }', 'with (o) with (p) x;'])(
        'a script parses %s',
        (src) => {
            expect(() => new Function(src), 'node must agree it is valid').not.toThrow();
            expect(errs(src, 'commonjs'), src).toEqual([]);
            expect(errs(src, 'unambiguous'), src).toEqual([]);
        },
    );

    it('a module rejects it — a module is always strict', () => {
        // oxc's PARSER accepts this and leaves it to semantic analysis; node rejects it outright,
        // and node is the oracle here.
        expect(errs('with (o) { x; }', 'module')).not.toEqual([]);
        expect(errs('with (o) { x; }', 'module')[0].msg).toMatch(/not allowed in a module/);
    });
});

describe('building', () => {
    it('the dev transform refuses it, with the reason', async () => {
        const { devTransform } = await import('../src/bundler/transform.ts');
        const r = devTransform('t.js', 'with (o) { x }', {});
        expect(r.errors.join('\n')).toMatch(/cannot be bundled/);
        expect(r.code).toBe('');
    });

    it('and so does a bundle, naming the file', async () => {
        const { bundle } = await import('../src/bundler/bundle.ts');
        const { createMemoryFs } = await import('../src/bundler/fs.ts');
        const r = await bundle({
            entry: '/main.js',
            external: [],
            fs: createMemoryFs({
                '/d.cjs': 'const o = { a: 1 };\nwith (o) { module.exports = a }',
                '/main.js': "import d from './d.cjs';\nexport const x = d;",
            }),
        } as never);
        expect(r.errors.join('\n')).toMatch(/^\/d\.cjs:\d+: `with` statements cannot be bundled/);
    });
});

describe('known gap', () => {
    // `"use strict"` is a DIRECTIVE, and the parser tracks no strict-mode state at all, so it cannot
    // see that this became strict code. node rejects it. Same root cause as the strict-only
    // legacy-octal rules (`01`, `08`) that are also still accepted.
    it('a "use strict" directive does not yet make `with` an error', () => {
        expect(() => new Function('"use strict"; with(o){}')).toThrow();
        expect(errs('"use strict"; with (o) {}', 'unambiguous')).toEqual([]);
    });
});
