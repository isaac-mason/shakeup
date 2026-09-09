import { describe, expect, it } from 'vitest';
import { bundle, createMemoryFs } from '../src/index.ts';

// A compress pass that rewrites a READ is doing its job. The SAME rewrite in a write position is a
// miscompile — and usually not a subtle one: `undefined = 1` becoming `void 0 = 1` is output no
// engine will parse, from a build reporting no errors.
//
// oxc cannot have this bug: its assignment targets are a different node type from its expressions,
// so a substitution is only ever offered a value. shakeup uses one `IdentifierReference` for both,
// which makes the distinction a thing every substituting pass has to remember — so it is checked
// here once, as a CROSS PRODUCT, rather than trusted pass by pass.
//
// It found four shapes that hand-written cases had missed (`[...x] = v`, `({ ...x } = v)`,
// `for (x of v)`, `[x = 9] = []`). Sabotage-checked: deleting the guard in `alternate-syntax.ts`
// fails ten of these.

/** `%s` goes in a WRITE position. */
const POSITIONS: [string, string][] = [
    ['assign', '%s = 1;'],
    ['compound', '%s += 1;'],
    ['increment', '%s++;'],
    ['decrement', '--%s;'],
    ['array destructuring', '[%s] = [1];'],
    ['object destructuring', '({ k: %s } = { k: 1 });'],
    // Shorthand only accepts a bare identifier, so the member-expression values are syntax errors
    // here and get skipped — which is exactly what the per-row skip is for.
    ['object shorthand', '({ %s } = { undefined: 1, Infinity: 1, NaN: 1, c: 1, a: 1 });'],
    ['array rest', '[...%s] = [1];'],
    ['object rest', '({ ...%s } = { k: 1 });'],
    ['for-in', 'for (%s in { a: 1 }) {}'],
    ['for-of', 'for (%s of [1]) {}'],
    ['destructuring default', '[%s = 9] = [];'],
];

/** Things some pass rewrites when it sees them as a value. `sink` keeps a binding live so
 *  drop-unused does not delete the fixture out from under the check. */
const VALUES: [string, string, string][] = [
    ['undefined', '', 'undefined'],
    ['Infinity', '', 'Infinity'],
    ['NaN', '', 'NaN'],
    ['a const-propagated local', 'let c = 1; sink(c);', 'c'],
    ['an alias', 'let b = v; let a = b; sink(a);', 'a'],
    ['a string-keyed member', 'const o = {};', 'o["k"]'],
    ['a dotted member', 'const o = {};', 'o.k'],
    ['a computed member', 'const o = {}; const i = 0;', 'o[i]'],
    ['a nested member', 'const o = { a: {} };', 'o.a.b'],
    ['a scalar-replaceable field', 'const s = { f: 1 }; sink(s.f);', 's.f'],
];

const evaluate = async (code: string): Promise<string> => {
    try {
        const ns = (await import(`data:text/javascript,${encodeURIComponent(code)}`)) as { r?: unknown };
        return JSON.stringify(ns.r ?? null);
    } catch (e) {
        return `THREW ${(e as Error).constructor.name}`;
    }
};

describe('no pass substitutes into a write position', () => {
    for (const [posName, position] of POSITIONS) {
        it(posName, async () => {
            let checked = 0;
            for (const [valName, prelude, expr] of VALUES) {
                const src = [
                    'export function f(v, sink) {',
                    prelude,
                    position.replace('%s', expr),
                    'return 1;',
                    '}',
                    'export const r = f(0, () => {});',
                ].join('\n');
                const fs = createMemoryFs({ '/e.js': src });
                const min = await bundle({ entry: '/e.js', fs, output: { minify: true, optimize: true } });
                const plain = await bundle({ entry: '/e.js', fs, output: { minify: false } });
                // A shape the parser or checker rejects is not this test's business — `const c = 1;
                // c = 1` and `import { K } from …; K = 1` are errors before any pass runs.
                if (min.errors.length > 0 || plain.errors.length > 0) continue;
                checked++;
                const label = `${posName} / ${valName}`;
                const code = min.chunks
                    .map((c) => c.code)
                    .join('')
                    .replace(/export\s*\{[^}]*\};?/g, '');
                // The output must PARSE. `new Function` throws a SyntaxError otherwise, and that is
                // the failure mode this whole file exists for.
                expect(() => new Function(code), `${label}\n${code}`).not.toThrow();
                // And it must still do what the unminified build does — including throwing the same
                // way, since several of these are TypeErrors under module strictness.
                expect(await evaluate(min.chunks.map((c) => c.code).join('')), label).toBe(
                    await evaluate(plain.chunks.map((c) => c.code).join('')),
                );
            }
            // If a parser change ever rejects every value, this test would pass while checking
            // nothing at all.
            expect(checked, 'every fixture was skipped').toBeGreaterThan(4);
        });
    }
});
